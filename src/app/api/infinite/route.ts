import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  INFINITE_DURATION_SECONDS,
  renderGeneratedScene,
} from "@/lib/fal/infinite-render";
import { ensureLastFrame } from "@/lib/fal/last-frame";
import {
  generateBranches,
  generateScene,
  isContinuationConfigured,
  type ContinuationContext,
  type StoryBeat,
} from "@/lib/story/continuation";
import type { GeneratedChoice, SceneTone, StoryNode } from "@/lib/story/types";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
/**
 * Advancing holds the connection open for the whole scene: a model call, then a render.
 * That is the trade this feature makes — the player is waiting on the next shot, so
 * there is nobody to hand a job id to.
 */
export const maxDuration = 300;

/*
 * Spend limits.
 *
 * Every generated beat is a real charge on the creator's fal account, triggered by
 * somebody who is not the creator. These are the ceiling on that. They are derived from
 * render_jobs rather than tracked in their own counter, so they cannot drift out of
 * sync with what was actually spent, and they survive a player clearing their session.
 */
const MAX_BEATS_PER_STORY_PER_HOUR = 12;
const MAX_BEATS_PER_PLAYER_PER_HOUR = 30;
const SPEND_WINDOW_MS = 60 * 60 * 1000;

/** A scene needs at least two ways out, or the player has been handed a dead end. */
const MIN_BRANCHES = 2;

const beatSchema = z.object({
  gameId: z.uuid(),
  /**
   * The scenes this player has actually watched, oldest first. Only their ids travel:
   * the prose is read back from the database, so nothing a client invents can reach the
   * model. Generated branches are shared between players, so a prompt injected here
   * would not poison one playthrough but every future one.
   */
  pathNodeIds: z.array(z.uuid()).min(1).max(40),
});

const branchesSchema = beatSchema.extend({
  action: z.literal("branches"),
  nodeId: z.uuid(),
});

const advanceSchema = beatSchema.extend({
  action: z.literal("advance"),
  choiceId: z.uuid(),
});

const requestSchema = z.discriminatedUnion("action", [branchesSchema, advanceSchema]);

type SupabaseAdmin = NonNullable<ReturnType<typeof createSupabaseAdminClient>>;

const TONES = new Set<SceneTone>(["rain", "greenhouse", "archive", "signal", "dawn"]);

interface GameRow {
  id: string;
  title: string;
  genre: string;
  logline: string;
  story_bible: unknown;
  infinite_mode: boolean;
}

interface NodeRow {
  id: string;
  title: string;
  eyebrow: string;
  narrative: string;
  video_prompt: string;
  tone: string;
  duration_seconds: number;
  render_status: StoryNode["renderStatus"];
  video_url: string | null;
  start_image_source: StoryNode["startImageSource"];
  start_image_from_node_id: string | null;
}

const nodeColumns =
  "id,title,eyebrow,narrative,video_prompt,tone,duration_seconds,render_status,video_url," +
  "start_image_source,start_image_from_node_id";

function storyBibleText(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") {
    return value.text;
  }
  return "";
}

/** Generated scenes never appear in the editor, so their canvas position is meaningless. */
function serializeNode(node: NodeRow): StoryNode {
  return {
    id: node.id,
    title: node.title,
    eyebrow: node.eyebrow,
    narrative: node.narrative,
    videoPrompt: node.video_prompt,
    tone: TONES.has(node.tone as SceneTone) ? (node.tone as SceneTone) : "signal",
    durationSeconds: node.duration_seconds,
    renderStatus: node.render_status,
    ...(node.video_url ? { videoUrl: node.video_url } : {}),
    position: { x: 0, y: 0 },
    origin: "generated",
    // A generated scene almost always continues from the shot the player just watched,
    // so this is reported as stored rather than assumed to be "none".
    startImageSource: node.start_image_source,
    ...(node.start_image_from_node_id
      ? { startImageFromNodeId: node.start_image_from_node_id }
      : {}),
    endImageSource: "none",
  };
}

function serializeChoice(row: {
  id: string;
  from_node_id: string;
  label: string;
  hint: string;
  to_node_id: string | null;
}): GeneratedChoice {
  return {
    id: row.id,
    fromNodeId: row.from_node_id,
    label: row.label,
    hint: row.hint,
    ...(row.to_node_id ? { toNodeId: row.to_node_id } : {}),
  };
}

async function authenticate() {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return { error: "Supabase is not configured", status: 500 } as const;

  const { data } = await supabase.auth.getUser();
  // Infinite mode spends the creator's money on the player's behalf, so unlike ordinary
  // playback it is not open to anonymous visitors.
  if (!data.user) {
    return { error: "Sign in to play stories in infinite mode", status: 401 } as const;
  }
  return { supabase, admin, user: data.user } as const;
}

/**
 * Rebuild the story so far from the database.
 *
 * Ids are filtered to the game and then re-ordered to match the path the client claims
 * to have walked, so a caller can at worst re-order scenes it was already allowed to see.
 */
async function loadContext(
  admin: SupabaseAdmin,
  game: GameRow,
  pathNodeIds: string[],
): Promise<ContinuationContext> {
  const { data } = await admin
    .from("story_nodes")
    .select("id,title,narrative")
    .eq("game_id", game.id)
    .in("id", pathNodeIds);

  const byId = new Map(
    ((data ?? []) as { id: string; title: string; narrative: string }[]).map((row) => [row.id, row]),
  );
  const path = pathNodeIds
    .map((id) => byId.get(id))
    .filter((row): row is { id: string; title: string; narrative: string } => Boolean(row))
    .map<StoryBeat>((row) => ({ title: row.title, narrative: row.narrative }));

  return {
    title: game.title,
    genre: game.genre,
    logline: game.logline,
    storyBible: storyBibleText(game.story_bible),
    path,
  };
}

/** Reject the request before anything is spent, rather than after. */
async function overSpendLimit(
  admin: SupabaseAdmin,
  userId: string,
  gameId: string,
) {
  const since = new Date(Date.now() - SPEND_WINDOW_MS).toISOString();
  const [perStory, perPlayer] = await Promise.all([
    admin
      .from("render_jobs")
      .select("id", { count: "exact", head: true })
      .eq("requested_by", userId)
      .eq("game_id", gameId)
      .eq("for_infinite", true)
      .gte("created_at", since),
    admin
      .from("render_jobs")
      .select("id", { count: "exact", head: true })
      .eq("requested_by", userId)
      .eq("for_infinite", true)
      .gte("created_at", since),
  ]);

  if ((perStory.count ?? 0) >= MAX_BEATS_PER_STORY_PER_HOUR) {
    return "You have generated a lot of this story in the last hour. Take a break and come back.";
  }
  if ((perPlayer.count ?? 0) >= MAX_BEATS_PER_PLAYER_PER_HOUR) {
    return "You have hit your hourly limit for generating new scenes.";
  }
  return null;
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  if (!isContinuationConfigured()) {
    return NextResponse.json({ error: "Infinite mode is not configured" }, { status: 503 });
  }

  const auth = await authenticate();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { supabase, admin, user } = auth;

  // Read through the caller's own client so RLS decides whether this story is theirs to
  // see at all; everything after this point runs as the service role.
  const { data: gameRow } = await supabase
    .from("games")
    .select("id,title,genre,logline,story_bible,infinite_mode")
    .eq("id", parsed.data.gameId)
    .maybeSingle();
  const game = gameRow as GameRow | null;
  if (!game) return NextResponse.json({ error: "Story not found" }, { status: 404 });
  if (!game.infinite_mode) {
    return NextResponse.json({ error: "This story is not in infinite mode" }, { status: 409 });
  }

  return parsed.data.action === "branches"
    ? offerBranches(admin, game, parsed.data.nodeId, parsed.data.pathNodeIds)
    : advance(admin, game, user.id, parsed.data.choiceId, parsed.data.pathNodeIds);
}

/**
 * Offer the branches available at a scene, inventing them if nobody has been here yet.
 *
 * This costs a fraction of a cent and no video, so it is safe to call speculatively
 * while the current shot is still playing. It is also self-limiting: once a scene has
 * branches, every later visitor is served the same ones for free.
 */
async function offerBranches(
  admin: SupabaseAdmin,
  game: GameRow,
  nodeId: string,
  pathNodeIds: string[],
) {
  const { data: node } = await admin
    .from("story_nodes")
    .select("id")
    .eq("id", nodeId)
    .eq("game_id", game.id)
    .maybeSingle();
  if (!node) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

  /*
   * Extract this scene's closing frame while the player is still watching it.
   *
   * The next scene opens on that frame, and this call is the one the player does not
   * wait for — it runs against the shot on screen. Doing it here takes a fal round trip
   * out of the gap between a choice and the video behind it, and the frame is cached on
   * the scene, so a player who quits here has warmed it for everyone who does not.
   */
  const warmFrame = ensureLastFrame(admin, game.id, nodeId);

  const existingQuery = () =>
    admin
      .from("generated_choices")
      .select("id,from_node_id,label,hint,to_node_id")
      .eq("from_node_id", nodeId)
      .order("created_at");

  const { data: existing } = await existingQuery();
  if ((existing?.length ?? 0) >= MIN_BRANCHES) {
    // Awaited rather than left running: on a serverless host the work stops when the
    // response does, and a half-finished extraction is one the next request repeats.
    await warmFrame;
    return NextResponse.json({ choices: (existing ?? []).map(serializeChoice) });
  }

  let branches;
  try {
    branches = await generateBranches(
      await loadContext(admin, game, pathNodeIds),
      (existing ?? []).map((row) => row.label as string),
    );
  } catch (error) {
    console.error("Infinite mode could not write branches", error);
    return NextResponse.json({ error: "The story could not think of what comes next." }, { status: 502 });
  }

  // Two players can reach a fresh scene together and both write branches. The unique
  // index on (from_node_id, label_key) decides it; ignoring the conflict means the
  // loser's duplicates are dropped and both players see the same list on re-read.
  await admin.from("generated_choices").upsert(
    branches.map((branch) => ({
      game_id: game.id,
      from_node_id: nodeId,
      label: branch.label,
      hint: branch.hint,
    })),
    { onConflict: "from_node_id,label_key", ignoreDuplicates: true },
  );

  const [{ data: refreshed }] = await Promise.all([existingQuery(), warmFrame]);
  return NextResponse.json({ choices: (refreshed ?? []).map(serializeChoice) });
}

/**
 * Walk a branch, minting the scene behind it if this is the first time anyone has.
 *
 * The expensive step is deliberately last. The model call that writes the scene costs a
 * fraction of a cent and can safely be thrown away if this request loses the race for
 * the branch; the render cannot, so it only happens once the branch is definitively ours.
 */
async function advance(
  admin: SupabaseAdmin,
  game: GameRow,
  userId: string,
  choiceId: string,
  pathNodeIds: string[],
) {
  const { data: choiceRow } = await admin
    .from("generated_choices")
    .select("id,from_node_id,label,hint,to_node_id")
    .eq("id", choiceId)
    .eq("game_id", game.id)
    .maybeSingle();
  if (!choiceRow) return NextResponse.json({ error: "That branch no longer exists" }, { status: 404 });
  const choice = choiceRow as {
    id: string;
    from_node_id: string;
    label: string;
    hint: string;
    to_node_id: string | null;
  };

  // Somebody has already been down here. This is the case that makes infinite mode
  // affordable: the second player through pays nothing and waits for nothing.
  if (choice.to_node_id) {
    return respondWithNode(admin, game.id, choice.to_node_id);
  }

  const limited = await overSpendLimit(admin, userId, game.id);
  if (limited) return NextResponse.json({ error: limited }, { status: 429 });

  /*
   * Continuity, started before the writing rather than after it.
   *
   * The new shot opens on the frame the scene behind it closed on, which is what keeps a
   * generated stretch looking like one continuous story instead of a run of unrelated
   * five-second clips. Extraction is a round trip to fal, so it is kicked off here and
   * collected once the scene has been written — the two have nothing to say to each other
   * and the player is waiting on both.
   *
   * The frame is cached on the scene it came from, so this is not wasted work even if
   * this request goes on to lose the race for the branch below.
   */
  const lastFramePromise = ensureLastFrame(admin, game.id, choice.from_node_id);

  const context = await loadContext(admin, game, pathNodeIds);
  let scene;
  try {
    scene = await generateScene(context, choice.label, choice.hint);
  } catch (error) {
    console.error("Infinite mode could not write a scene", error);
    // Settled before returning, for the same reason it is awaited on the cached-branch
    // path: the host stops the work when the response does, and an extraction killed
    // half-way is a fal call paid for twice and a stored frame nothing points at.
    await lastFramePromise;
    return NextResponse.json({ error: "The story could not think of what comes next." }, { status: 502 });
  }

  // Never fatal: `ensureLastFrame` reports a failure as no frame, and a scene generated
  // from its prompt alone is a better answer for a waiting player than an error.
  const startImageUrl = await lastFramePromise;

  const nodeId = randomUUID();
  const { error: insertError } = await admin.from("story_nodes").insert({
    id: nodeId,
    game_id: game.id,
    origin: "generated",
    title: scene.title,
    eyebrow: scene.eyebrow,
    narrative: scene.narrative,
    video_prompt: scene.videoPrompt,
    tone: scene.tone,
    duration_seconds: INFINITE_DURATION_SECONDS,
    render_status: "queued",
    // Recorded as inheritance rather than as an upload, so the scene says what it opened
    // on and where that came from — the same shape an authored chained scene has.
    ...(startImageUrl
      ? { start_image_source: "inherit", start_image_from_node_id: choice.from_node_id }
      : {}),
  });
  if (insertError) {
    console.error("Infinite mode could not store a scene", insertError);
    return NextResponse.json({ error: "Unable to save the new scene" }, { status: 500 });
  }

  const { data: winner, error: reserveError } = await admin.rpc("reserve_generated_branch", {
    p_choice_id: choice.id,
    p_node_id: nodeId,
  });
  if (reserveError) {
    await admin.from("story_nodes").delete().eq("id", nodeId);
    return NextResponse.json({ error: "Unable to claim this branch" }, { status: 500 });
  }

  // Another request got here first. Drop the scene we wrote and wait on theirs instead —
  // the only thing lost is a model call, which is exactly why the render comes after this.
  if (winner !== nodeId) {
    await admin.from("story_nodes").delete().eq("id", nodeId);
    return respondWithNode(admin, game.id, winner as string);
  }

  const render = await renderGeneratedScene(admin, {
    gameId: game.id,
    nodeId,
    prompt: scene.videoPrompt,
    requestedBy: userId,
    ...(startImageUrl ? { startImageUrl } : {}),
  });
  if (!render.ok) {
    // Hand the branch back. Left reserved, it would point at a scene that never renders,
    // and every future player down this path would inherit the failure with no way to
    // retry. The failed scene and its job row are kept: they are the record of the spend.
    await admin
      .from("generated_choices")
      .update({ to_node_id: null })
      .eq("id", choice.id)
      .eq("to_node_id", nodeId);
    return NextResponse.json({ error: render.message }, { status: 502 });
  }

  return respondWithNode(admin, game.id, nodeId);
}

async function respondWithNode(
  admin: SupabaseAdmin,
  gameId: string,
  nodeId: string,
) {
  const { data } = await admin
    .from("story_nodes")
    .select(nodeColumns)
    .eq("id", nodeId)
    .eq("game_id", gameId)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "Scene not found" }, { status: 404 });
  return NextResponse.json({ node: serializeNode(data as unknown as NodeRow) });
}

/**
 * Check on a scene somebody else is rendering.
 *
 * Reached when two players take the same new branch at once: the one who lost the race
 * has a scene id but no video yet, and polls here until the winner's render lands.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId") ?? "";
  const nodeId = url.searchParams.get("nodeId") ?? "";
  if (!z.uuid().safeParse(gameId).success || !z.uuid().safeParse(nodeId).success) {
    return NextResponse.json({ error: "Invalid story or scene" }, { status: 400 });
  }

  const auth = await authenticate();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: game } = await auth.supabase
    .from("games")
    .select("id")
    .eq("id", gameId)
    .maybeSingle();
  if (!game) return NextResponse.json({ error: "Story not found" }, { status: 404 });

  return respondWithNode(auth.admin, gameId, nodeId);
}
