import { randomUUID } from "node:crypto";
import { fal } from "@fal-ai/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FRAME_BUCKET,
  MAX_FRAME_BYTES,
  detectImageMime,
  frameColumns,
  frameExtension,
  frameObjectPath,
  hasFreshLastFrame,
  removeFrameByUrl,
  type FrameNodeRow,
} from "@/lib/story/frames";

/**
 * Get the closing still of a scene, extracting it server-side if nobody has yet.
 *
 * The studio captures last frames in the author's browser, which works because an author
 * is sitting in front of the video with the story open. Infinite mode has neither: the
 * scene a generated shot continues from is usually itself generated, so no browser ever
 * opened it, and the render happens inside a request the author knows nothing about.
 * ffmpeg is deliberately not part of this deployment, so the frame is pulled by the same
 * provider that made the video.
 *
 * Returns null rather than throwing. A missing frame means the next shot is generated
 * from its prompt alone — worse continuity, but still a scene, which is the right trade
 * when a player is waiting on it.
 */
const EXTRACT_ENDPOINT = "fal-ai/ffmpeg-api/extract-frame";
/** Extraction sits in the player's critical path, so it gets a far shorter leash than a render. */
const EXTRACT_TIMEOUT_MS = 45_000;

function extractedImageUrl(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const images = (output as { images?: unknown }).images;
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const first: unknown = images[0];
  if (!first || typeof first !== "object") return undefined;
  const url = (first as { url?: unknown }).url;
  return typeof url === "string" ? url : undefined;
}

export async function ensureLastFrame(
  admin: SupabaseClient,
  gameId: string,
  nodeId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("story_nodes")
    .select(frameColumns)
    .eq("id", nodeId)
    .eq("game_id", gameId)
    .maybeSingle();
  const node = data as unknown as FrameNodeRow | null;
  if (!node?.video_url) return null;

  // Already extracted, and still the frame of the video this scene plays. Every player
  // after the first down a branch takes this path, so extraction is paid for once per
  // scene no matter how many times the branch is walked.
  if (hasFreshLastFrame(node)) return node.last_frame_url;

  const videoUrl = node.video_url;
  try {
    const result = await fal.subscribe(EXTRACT_ENDPOINT, {
      input: { video_url: videoUrl, frame_type: "last" },
      timeout: EXTRACT_TIMEOUT_MS,
    });

    const imageUrl = extractedImageUrl(result.data);
    if (!imageUrl) throw new Error("fal returned no frame");

    // The still is copied into our own bucket rather than passed on as a fal url: it is
    // an input to every future render down this path, and outliving the provider's
    // temporary media is the difference between continuity and a re-rolled shot.
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error(`Frame download failed with ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FRAME_BYTES) {
      throw new Error("The extracted frame was empty or too large");
    }
    const mime = detectImageMime(bytes);
    if (!mime) throw new Error("The extracted frame was not a PNG, JPEG, or WebP");

    const path = frameObjectPath(gameId, nodeId, "last", randomUUID(), frameExtension(mime));
    const { error: uploadError } = await admin.storage
      .from(FRAME_BUCKET)
      .upload(path, bytes, { contentType: mime, upsert: false });
    if (uploadError) throw new Error("Unable to store the extracted frame");

    const url = admin.storage.from(FRAME_BUCKET).getPublicUrl(path).data.publicUrl;

    // Guarded on the video it came from, the same way the studio's upload is: a take
    // chosen while this ran would otherwise cache a still from a shot nobody plays.
    const { data: updated } = await admin
      .from("story_nodes")
      .update({
        last_frame_url: url,
        last_frame_source_video_url: videoUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", nodeId)
      .eq("game_id", gameId)
      .eq("video_url", videoUrl)
      .select("id");
    if (!updated?.length) {
      await removeFrameByUrl(admin, url);
      return null;
    }

    // Only the still this scene used to point at is cleaned up. Two players reaching a
    // fresh scene together both extract, and dropping the other one's object here would
    // pull the frame out from under whichever write landed second.
    await removeFrameByUrl(admin, node.last_frame_url);
    return url;
  } catch (error) {
    console.error("Unable to extract a last frame for continuity", { nodeId, error });
    return null;
  }
}
