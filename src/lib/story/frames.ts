import type { SupabaseClient } from "@supabase/supabase-js";

/** Public bucket: fal fetches these stills over plain https when a render is submitted. */
export const FRAME_BUCKET = "scene-frames";

export const FRAME_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_FRAME_BYTES = 10 * 1024 * 1024;

export type FrameSlot = "start" | "end" | "last";

/** Columns needed to work out which stills a scene renders with. */
export const frameColumns =
  "id,game_id,video_url,start_image_source,end_image_source,start_image_url," +
  "end_image_url,start_image_from_node_id,last_frame_url,last_frame_source_video_url";

export interface FrameNodeRow {
  id: string;
  game_id: string;
  video_url: string | null;
  start_image_source: "none" | "upload" | "inherit";
  end_image_source: "none" | "upload";
  start_image_url: string | null;
  end_image_url: string | null;
  start_image_from_node_id: string | null;
  last_frame_url: string | null;
  last_frame_source_video_url: string | null;
}

/**
 * A cached last frame is only trustworthy while it still belongs to the video the scene
 * currently plays. Choosing a different take, or re-rendering, leaves the old still
 * behind — using it anyway would chain the next scene onto a shot no one watches.
 */
export function hasFreshLastFrame(node: Pick<FrameNodeRow, "video_url" | "last_frame_url" | "last_frame_source_video_url">) {
  return Boolean(
    node.video_url && node.last_frame_url && node.last_frame_source_video_url === node.video_url,
  );
}

export type ResolvedFrames =
  | { ok: true; startImageUrl?: string; endImageUrl?: string }
  | { ok: false; reason: string };

/**
 * Work out the stills a scene should be generated with, reading only from the database.
 *
 * The browser never gets to name the image: it says *which scene* to render and the
 * server decides what that scene opens and closes on. That keeps an arbitrary url from
 * being handed to fal, and means an inherited frame always reflects the source scene as
 * it stands right now rather than whatever the studio last had in memory.
 */
export async function resolveSceneFrames(
  admin: SupabaseClient,
  gameId: string,
  nodeId: string,
): Promise<ResolvedFrames> {
  const { data, error } = await admin
    .from("story_nodes")
    .select(frameColumns)
    .eq("id", nodeId)
    .eq("game_id", gameId)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "Scene not found" };
  const node = data as unknown as FrameNodeRow;

  let startImageUrl: string | undefined;
  if (node.start_image_source === "upload" && node.start_image_url) {
    startImageUrl = node.start_image_url;
  } else if (node.start_image_source === "inherit") {
    if (!node.start_image_from_node_id) {
      return { ok: false, reason: "Pick which scene this one continues from, or turn off continuity." };
    }
    const { data: sourceData } = await admin
      .from("story_nodes")
      .select(frameColumns)
      .eq("id", node.start_image_from_node_id)
      .eq("game_id", gameId)
      .maybeSingle();
    const source = sourceData as unknown as FrameNodeRow | null;
    if (!source) {
      return { ok: false, reason: "The scene this one continues from no longer exists." };
    }
    if (!source.video_url) {
      return { ok: false, reason: "Generate the scene this one continues from first." };
    }
    if (!hasFreshLastFrame(source)) {
      // The studio captures frames as soon as a take is chosen, so this is a backstop
      // for a scene whose video changed in another tab.
      return {
        ok: false,
        reason: "The last frame of the previous scene is out of date. Reopen that scene to capture it again.",
      };
    }
    startImageUrl = source.last_frame_url ?? undefined;
  }

  const endImageUrl = node.end_image_source === "upload" && node.end_image_url
    ? node.end_image_url
    : undefined;

  return {
    ok: true,
    ...(startImageUrl ? { startImageUrl } : {}),
    ...(endImageUrl ? { endImageUrl } : {}),
  };
}

/**
 * Magic-byte sniff. The bucket is public and its contents are handed to a third party,
 * so a declared content-type alone is not enough to go on.
 */
export function detectImageMime(bytes: Uint8Array): (typeof FRAME_MIME_TYPES)[number] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const extensionByMime: Record<(typeof FRAME_MIME_TYPES)[number], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function frameExtension(mime: (typeof FRAME_MIME_TYPES)[number]) {
  return extensionByMime[mime];
}

/**
 * Storage path for a still. The game id leads so a storage policy can check ownership
 * from the object name alone.
 */
export function frameObjectPath(gameId: string, nodeId: string, slot: FrameSlot, id: string, ext: string) {
  return `${gameId}/${nodeId}/${slot}-${id}.${ext}`;
}

/**
 * Best-effort removal of a still this scene is about to stop pointing at. Only objects
 * inside our own bucket are touched, and a failure is ignored: an orphaned file is a
 * tidiness problem, a failed upload is the author's problem.
 */
export async function removeFrameByUrl(admin: SupabaseClient, url: string | null | undefined) {
  if (!url) return;
  const marker = `/${FRAME_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return;
  const path = url.slice(index + marker.length).split("?")[0];
  if (!path) return;
  await admin.storage.from(FRAME_BUCKET).remove([decodeURIComponent(path)]).catch(() => undefined);
}
