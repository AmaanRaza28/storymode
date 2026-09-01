import { randomUUID } from "node:crypto";
import { fal } from "@fal-ai/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RenderResolution } from "@/lib/story/types";

/**
 * Rendering for infinite mode, which waits rather than queues.
 *
 * The studio submits through `fal.queue.submit` and hears back over a webhook, because
 * an author queues a render and walks away. A player cannot walk away — the next scene
 * is the thing they are waiting for — so this path blocks on `fal.subscribe` and returns
 * a finished video. H3 Max renders a five-second clip in roughly three seconds, which is
 * comfortably inside the shot the player is still watching.
 *
 * No `webhookUrl` is passed: the completion is handled here, and giving fal a webhook as
 * well would have two writers racing to finish the same job.
 */
const TEXT_ENDPOINT = "minimax/h3-max/text-to-video";
/** Reached whenever the previous shot has a closing still, which for a played story is always. */
const IMAGE_ENDPOINT = "minimax/h3-max/image-to-video";

/**
 * Infinite scenes are the cheap tier on purpose. At 768P a generated beat costs $0.40
 * against $0.25 here, and a story that generates as fast as it is watched multiplies
 * that difference by every branch anyone ever takes.
 */
export const INFINITE_RESOLUTION: RenderResolution = "480P";
export const INFINITE_DURATION_SECONDS = 5;

/** Past this, assume the render is wedged rather than slow, and fail with something sayable. */
const RENDER_TIMEOUT_MS = 180_000;

export type RenderResult =
  | { ok: true; videoUrl: string }
  | { ok: false; message: string };

interface RenderRequest {
  gameId: string;
  nodeId: string;
  prompt: string;
  requestedBy: string;
  /**
   * The closing frame of the scene the player is watching, when it could be extracted.
   * Continuity is the default here rather than an author's choice: a generated shot has
   * no set dressing to fall back on but the one it cuts from, and a story that re-rolls
   * its cast every five seconds reads as five-second clips rather than as a story.
   */
  startImageUrl?: string;
}

function videoUrlFrom(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const video = (output as { video?: unknown }).video;
  if (!video || typeof video !== "object") return undefined;
  const url = (video as { url?: unknown }).url;
  return typeof url === "string" ? url : undefined;
}

export async function renderGeneratedScene(
  admin: SupabaseClient,
  { gameId, nodeId, prompt, requestedBy, startImageUrl }: RenderRequest,
): Promise<RenderResult> {
  const input = {
    prompt,
    duration: INFINITE_DURATION_SECONDS,
    resolution: INFINITE_RESOLUTION,
    prompt_expansion_mode: "balanced",
    enable_safety_checker: true,
    ...(startImageUrl ? { image_url: startImageUrl } : {}),
  };
  // Only the image-to-video endpoint takes a still at all, so the frame decides which
  // model the beat is rendered by.
  const endpoint = startImageUrl ? IMAGE_ENDPOINT : TEXT_ENDPOINT;

  // The job row exists before the spend does, so a render that dies mid-flight is still
  // attributable to the player who triggered it when the spend window is next checked.
  const jobId = randomUUID();
  const { error: jobError } = await admin.from("render_jobs").insert({
    id: jobId,
    game_id: gameId,
    node_id: nodeId,
    provider: "fal",
    model: endpoint,
    status: "rendering",
    requested_by: requestedBy,
    for_infinite: true,
    input,
  });
  if (jobError) return { ok: false, message: "Unable to start this scene's render." };

  await admin
    .from("story_nodes")
    .update({ render_status: "rendering", updated_at: new Date().toISOString() })
    .eq("id", nodeId)
    .eq("game_id", gameId);

  try {
    const result = await fal.subscribe(endpoint, {
      input,
      timeout: RENDER_TIMEOUT_MS,
      onEnqueue: (requestId) => {
        // Fire and forget: this only exists so an abandoned render can be traced back to
        // a fal request, and waiting on it would add a round trip to the hot path.
        void admin
          .from("render_jobs")
          .update({ provider_request_id: requestId })
          .eq("id", jobId);
      },
    });

    const videoUrl = videoUrlFrom(result.data);
    if (!videoUrl) throw new Error("fal completed without returning a video");

    const completedAt = new Date().toISOString();
    await Promise.all([
      admin
        .from("render_jobs")
        .update({
          status: "ready",
          output: result.data,
          provider_request_id: result.requestId,
          completed_at: completedAt,
        })
        .eq("id", jobId),
      admin
        .from("story_nodes")
        .update({ render_status: "ready", video_url: videoUrl, updated_at: completedAt })
        .eq("id", nodeId)
        .eq("game_id", gameId),
    ]);

    return { ok: true, videoUrl };
  } catch (error) {
    const completedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : "The render failed";
    await Promise.all([
      admin
        .from("render_jobs")
        .update({ status: "failed", error: { message }, completed_at: completedAt })
        .eq("id", jobId),
      admin
        .from("story_nodes")
        .update({ render_status: "failed", updated_at: completedAt })
        .eq("id", nodeId)
        .eq("game_id", gameId),
    ]);
    return { ok: false, message };
  }
}
