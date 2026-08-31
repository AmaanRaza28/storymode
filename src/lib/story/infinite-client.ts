import type { GeneratedChoice, StoryNode } from "@/lib/story/types";

/**
 * Browser-side calls into infinite mode.
 *
 * Kept out of the player component because minting a scene is not a plain request: the
 * caller may be the one paying for a render, or may be the second person to ask for the
 * same one and have to wait on somebody else's.
 */

/** A losing racer waits on the winner's render. H3 Max is fast, but not instant. */
const POLL_INTERVAL_MS = 1500;
const POLL_ATTEMPTS = 60;

export class InfiniteModeError extends Error {}

async function readError(response: Response, fallback: string) {
  const body = await response.json().catch(() => null);
  const message = body && typeof body.error === "string" ? body.error : fallback;
  return new InfiniteModeError(message);
}

/** Ask what the player could do next here. Cheap: no video is generated. */
export async function fetchBranches(
  gameId: string,
  nodeId: string,
  pathNodeIds: string[],
  signal?: AbortSignal,
): Promise<GeneratedChoice[]> {
  const response = await fetch("/api/infinite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "branches", gameId, nodeId, pathNodeIds }),
    signal,
  });
  if (!response.ok) throw await readError(response, "The story could not decide what comes next.");
  const body = (await response.json()) as { choices: GeneratedChoice[] };
  return body.choices ?? [];
}

async function pollUntilReady(gameId: string, nodeId: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (signal?.aborted) throw new InfiniteModeError("Cancelled");

    const response = await fetch(
      `/api/infinite?gameId=${encodeURIComponent(gameId)}&nodeId=${encodeURIComponent(nodeId)}`,
      { signal },
    );
    if (!response.ok) throw await readError(response, "Lost track of the new scene.");
    const body = (await response.json()) as { node: StoryNode };
    if (body.node.renderStatus === "ready" && body.node.videoUrl) return body.node;
    if (body.node.renderStatus === "failed") {
      throw new InfiniteModeError("That scene failed to render. Try a different choice.");
    }
  }
  throw new InfiniteModeError("The next scene is taking too long. Try again in a moment.");
}

/**
 * Walk a branch, and come back with a scene that is ready to play.
 *
 * Resolves either because this call generated the scene or because it waited out
 * somebody else's generation of the same one — the caller cannot tell the difference,
 * and does not need to.
 */
export async function mintBranch(
  gameId: string,
  choiceId: string,
  pathNodeIds: string[],
  signal?: AbortSignal,
): Promise<StoryNode> {
  const response = await fetch("/api/infinite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "advance", gameId, choiceId, pathNodeIds }),
    signal,
  });
  if (!response.ok) throw await readError(response, "The next scene could not be created.");

  const body = (await response.json()) as { node: StoryNode };
  if (body.node.renderStatus === "ready" && body.node.videoUrl) return body.node;
  return pollUntilReady(gameId, body.node.id, signal);
}
