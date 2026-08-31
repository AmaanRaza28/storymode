import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { fal } from "@fal-ai/client";
import { z } from "zod";
import { processFalWebhook, type FalWebhookPayload } from "@/lib/fal/process-webhook";
import {
  reconcileRenderJob,
  serializeRenderJob,
  type RenderJobRow,
} from "@/lib/fal/render-jobs";
import { resolveSceneFrames } from "@/lib/story/frames";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const renderRequestSchema = z.object({
  gameId: z.string().min(1).max(120),
  nodeId: z.string().min(1).max(120),
  prompt: z.string().min(20).max(7000),
  duration: z.number().int().min(5).max(15).default(5),
  resolution: z.enum(["480P", "768P"]).default("480P"),
});

const selectTakeSchema = z.object({
  gameId: z.uuid(),
  nodeId: z.uuid(),
  jobId: z.uuid(),
});

const jobSelection = "id,node_id,requested_by,model,provider_request_id,status,input,output,error,created_at,completed_at";

/** Every attempt is kept as a take, so a busy story is paged rather than loaded whole. */
const TAKE_HISTORY_LIMIT = 400;
/** Authors may queue extra takes while one renders, but not spend without limit on a click. */
const MAX_ACTIVE_TAKES_PER_SCENE = 3;

async function authenticatedClients() {
  const supabase = await createSupabaseServerClient();
  const { data: authData } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  const admin = createSupabaseAdminClient();
  return { supabase, user: authData.user, admin };
}

export async function GET(request: Request) {
  const { supabase, user, admin } = await authenticatedClients();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 });

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  if (jobId) {
    const { data, error } = await admin
      .from("render_jobs")
      .select(jobSelection)
      .eq("id", jobId)
      .eq("requested_by", user.id)
      .maybeSingle();
    if (error || !data) return NextResponse.json({ error: "Render job not found" }, { status: 404 });

    try {
      return NextResponse.json({ job: await reconcileRenderJob(admin, data as RenderJobRow) });
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "Unable to check fal render status",
      }, { status: 502 });
    }
  }

  const gameId = url.searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "gameId or jobId is required" }, { status: 400 });
  const { data: ownedGame } = await supabase
    .from("games")
    .select("id")
    .eq("id", gameId)
    .eq("creator_id", user.id)
    .maybeSingle();
  if (!ownedGame) return NextResponse.json({ error: "Game not found or not owned by you" }, { status: 403 });

  const { data, error } = await admin
    .from("render_jobs")
    .select(jobSelection)
    .eq("game_id", gameId)
    .eq("requested_by", user.id)
    .order("created_at", { ascending: false })
    .limit(TAKE_HISTORY_LIMIT);
  if (error) return NextResponse.json({ error: "Unable to load render jobs" }, { status: 500 });

  // Every attempt is returned, not just the newest per scene: the studio shows them as
  // takes the author can replay and choose between.
  return NextResponse.json({
    jobs: ((data ?? []) as RenderJobRow[]).map((job) => serializeRenderJob(job)),
  });
}

export async function POST(request: Request) {
  const parsed = renderRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid render request", issues: parsed.error.issues }, { status: 400 });
  }

  if (!process.env.FAL_KEY) {
    return NextResponse.json({ error: "fal.ai is not configured" }, { status: 503 });
  }

  const { supabase, user, admin } = await authenticatedClients();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  if (!admin) {
    return NextResponse.json({ error: "Supabase service credentials are required for rendering" }, { status: 500 });
  }

  if (supabase) {
    const { data: ownedGame } = await supabase
      .from("games")
      .select("id")
      .eq("id", parsed.data.gameId)
      .eq("creator_id", user.id)
      .maybeSingle();
    if (!ownedGame) return NextResponse.json({ error: "Game not found or not owned by you" }, { status: 403 });

    const { data: ownedNode } = await supabase
      .from("story_nodes")
      .select("id")
      .eq("id", parsed.data.nodeId)
      .eq("game_id", parsed.data.gameId)
      .maybeSingle();
    if (!ownedNode) return NextResponse.json({ error: "Scene does not belong to this game" }, { status: 404 });
  }

  // The stills come from the scene as stored, never from the request body: an author
  // asks for *this scene* to be rendered and the server decides what it opens and closes
  // on. A scene set to continue from another one is resolved here, so it always picks up
  // the source scene's current last frame.
  const frames = await resolveSceneFrames(admin, parsed.data.gameId, parsed.data.nodeId);
  if (!frames.ok) {
    return NextResponse.json({ error: frames.reason }, { status: 409 });
  }

  const input = {
    prompt: parsed.data.prompt,
    duration: parsed.data.duration,
    resolution: parsed.data.resolution,
    prompt_expansion_mode: "balanced",
    enable_safety_checker: true,
    ...(frames.startImageUrl ? { image_url: frames.startImageUrl } : {}),
    ...(frames.endImageUrl ? { end_image_url: frames.endImageUrl } : {}),
  };
  // Only the image-to-video endpoint takes stills at all, and it accepts either or both,
  // so an end frame on its own still has to go there rather than to text-to-video.
  const endpoint = frames.startImageUrl || frames.endImageUrl
    ? "minimax/h3-max/image-to-video"
    : "minimax/h3-max/text-to-video";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return NextResponse.json({ error: "NEXT_PUBLIC_APP_URL is required" }, { status: 500 });

  // Re-generating no longer replaces the take in flight; it adds one, up to a cap that
  // keeps a double-click from becoming a double spend many times over.
  const { count: activeTakes, error: activeCountError } = await admin
    .from("render_jobs")
    .select("id", { count: "exact", head: true })
    .eq("node_id", parsed.data.nodeId)
    .eq("requested_by", user.id)
    .in("status", ["queued", "rendering"]);
  if (activeCountError) {
    return NextResponse.json({ error: "Unable to check renders in progress" }, { status: 500 });
  }
  if ((activeTakes ?? 0) >= MAX_ACTIVE_TAKES_PER_SCENE) {
    return NextResponse.json({
      error: `This scene already has ${activeTakes} takes rendering. Wait for one to finish before generating another.`,
    }, { status: 429 });
  }

  const jobId = randomUUID();
  const { error: jobInsertError } = await admin.from("render_jobs").insert({
    id: jobId,
    game_id: parsed.data.gameId,
    node_id: parsed.data.nodeId,
    provider: "fal",
    model: endpoint,
    provider_request_id: null,
    status: "queued",
    requested_by: user.id,
    input,
  });
  if (jobInsertError) {
    return NextResponse.json({ error: "Unable to create render job" }, { status: 500 });
  }

  await admin
    .from("story_nodes")
    .update({ render_status: "queued", updated_at: new Date().toISOString() })
    .eq("id", parsed.data.nodeId)
    .eq("game_id", parsed.data.gameId)
    // A scene with a chosen video stays 'ready' while an extra take renders.
    .is("video_url", null);

  let result: Awaited<ReturnType<typeof fal.queue.submit>>;
  try {
    result = await fal.queue.submit(endpoint, {
      input,
      webhookUrl: `${appUrl.replace(/\/$/, "")}/api/webhooks/fal`,
    });
  } catch (error) {
    await admin
      .from("render_jobs")
      .update({ status: "failed", error: { message: error instanceof Error ? error.message : "fal submit failed" } })
      .eq("id", jobId);
    await admin
      .from("story_nodes")
      .update({ render_status: "failed", updated_at: new Date().toISOString() })
      .eq("id", parsed.data.nodeId)
      .is("video_url", null);
    return NextResponse.json({ error: "Unable to submit render" }, { status: 502 });
  }

  await admin.from("render_jobs").update({ provider_request_id: result.request_id }).eq("id", jobId);

  const { data: earlyWebhook } = await admin
    .from("webhook_events")
    .select("payload,webhook_request_id")
    .eq("provider_request_id", result.request_id)
    .maybeSingle();
  if (earlyWebhook) {
    await processFalWebhook(
      admin,
      earlyWebhook.payload as FalWebhookPayload,
      earlyWebhook.webhook_request_id,
    );
  }

  const createdJob: RenderJobRow = {
    id: jobId,
    node_id: parsed.data.nodeId,
    requested_by: user.id,
    model: endpoint,
    provider_request_id: result.request_id,
    status: "queued",
    input,
    output: null,
    error: null,
    created_at: new Date().toISOString(),
    completed_at: null,
  };
  return NextResponse.json({
    mode: "fal",
    requestId: result.request_id,
    status: "IN_QUEUE",
    job: serializeRenderJob(createdJob, { message: "Waiting for a render worker" }),
  }, { status: 202 });
}

/** Choose which of a scene's takes plays in the story. */
export async function PATCH(request: Request) {
  const parsed = selectTakeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid take selection", issues: parsed.error.issues }, { status: 400 });
  }

  const { supabase, user, admin } = await authenticatedClients();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 });

  const { data: ownedGame } = await supabase
    .from("games")
    .select("id")
    .eq("id", parsed.data.gameId)
    .eq("creator_id", user.id)
    .maybeSingle();
  if (!ownedGame) return NextResponse.json({ error: "Game not found or not owned by you" }, { status: 403 });

  const { data: jobRow } = await admin
    .from("render_jobs")
    .select(jobSelection)
    .eq("id", parsed.data.jobId)
    .eq("node_id", parsed.data.nodeId)
    .eq("game_id", parsed.data.gameId)
    .eq("requested_by", user.id)
    .maybeSingle();
  if (!jobRow) return NextResponse.json({ error: "Take not found" }, { status: 404 });

  const take = serializeRenderJob(jobRow as RenderJobRow);
  if (take.status !== "ready" || !take.videoUrl) {
    return NextResponse.json({ error: "That take has not finished rendering yet" }, { status: 409 });
  }

  const { error } = await admin
    .from("story_nodes")
    .update({
      render_status: "ready",
      video_url: take.videoUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.nodeId)
    .eq("game_id", parsed.data.gameId);
  if (error) return NextResponse.json({ error: "Unable to use that take" }, { status: 500 });

  return NextResponse.json({ nodeId: parsed.data.nodeId, videoUrl: take.videoUrl, job: take });
}
