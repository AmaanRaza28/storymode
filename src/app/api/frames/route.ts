import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  FRAME_BUCKET,
  MAX_FRAME_BYTES,
  detectImageMime,
  frameExtension,
  frameObjectPath,
  removeFrameByUrl,
  type FrameSlot,
} from "@/lib/story/frames";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const slots = new Set<FrameSlot>(["start", "end", "last"]);

const clearSchema = z.object({
  gameId: z.uuid(),
  nodeId: z.uuid(),
  slot: z.enum(["start", "end"]),
});

/** Which columns a slot owns, so upload and clear cannot drift apart. */
const columnsForSlot = {
  start: { url: "start_image_url", source: "start_image_source" },
  end: { url: "end_image_url", source: "end_image_source" },
} as const;

async function authorize(gameId: string, nodeId: string) {
  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) {
    return { error: NextResponse.json({ error: "Supabase is not configured" }, { status: 500 }) };
  }

  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) {
    return { error: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  }

  const { data: ownedGame } = await supabase
    .from("games")
    .select("id")
    .eq("id", gameId)
    .eq("creator_id", authData.user.id)
    .maybeSingle();
  if (!ownedGame) {
    return { error: NextResponse.json({ error: "Game not found or not owned by you" }, { status: 403 }) };
  }

  const { data: node } = await admin
    .from("story_nodes")
    .select("id,video_url,start_image_url,end_image_url,last_frame_url")
    .eq("id", nodeId)
    .eq("game_id", gameId)
    .maybeSingle();
  if (!node) {
    return { error: NextResponse.json({ error: "Scene does not belong to this game" }, { status: 404 }) };
  }

  return { admin, node: node as {
    id: string;
    video_url: string | null;
    start_image_url: string | null;
    end_image_url: string | null;
    last_frame_url: string | null;
  } };
}

/**
 * Store a still for a scene.
 *
 * Two callers, one path: the author picking their own image, and the studio handing back
 * a frame it captured from a finished video. Both end up as an object in a public bucket
 * whose url is the only thing ever passed to fal.
 */
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected a multipart upload" }, { status: 400 });

  const gameId = String(form.get("gameId") ?? "");
  const nodeId = String(form.get("nodeId") ?? "");
  const slot = String(form.get("slot") ?? "") as FrameSlot;
  const file = form.get("file");

  if (!z.uuid().safeParse(gameId).success || !z.uuid().safeParse(nodeId).success) {
    return NextResponse.json({ error: "Invalid game or scene" }, { status: 400 });
  }
  if (!slots.has(slot)) return NextResponse.json({ error: "Invalid frame slot" }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "No image was uploaded" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "That image is empty" }, { status: 400 });
  if (file.size > MAX_FRAME_BYTES) {
    return NextResponse.json({ error: "Images must be 10MB or smaller" }, { status: 413 });
  }

  const authorized = await authorize(gameId, nodeId);
  if ("error" in authorized) return authorized.error;
  const { admin, node } = authorized;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = detectImageMime(bytes);
  if (!mime) {
    return NextResponse.json({ error: "Upload a PNG, JPEG, or WebP image" }, { status: 415 });
  }

  // A captured frame is only worth storing against the video it came from; if the scene
  // has moved to a different take in the meantime the capture is already stale.
  const sourceVideoUrl = slot === "last" ? String(form.get("sourceVideoUrl") ?? "") : "";
  if (slot === "last" && (!sourceVideoUrl || sourceVideoUrl !== node.video_url)) {
    return NextResponse.json({ error: "This scene's video changed while the frame was captured" }, { status: 409 });
  }

  const path = frameObjectPath(gameId, nodeId, slot, randomUUID(), frameExtension(mime));
  const { error: uploadError } = await admin.storage
    .from(FRAME_BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (uploadError) {
    return NextResponse.json({ error: "Unable to store that image" }, { status: 502 });
  }

  const url = admin.storage.from(FRAME_BUCKET).getPublicUrl(path).data.publicUrl;
  const previousUrl = slot === "start"
    ? node.start_image_url
    : slot === "end"
      ? node.end_image_url
      : node.last_frame_url;

  const updates = slot === "last"
    ? { last_frame_url: url, last_frame_source_video_url: sourceVideoUrl }
    : {
      [columnsForSlot[slot].url]: url,
      [columnsForSlot[slot].source]: "upload",
      // Choosing your own opening still replaces whatever it was continuing from.
      ...(slot === "start" ? { start_image_from_node_id: null } : {}),
    };

  const { error: updateError } = await admin
    .from("story_nodes")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", nodeId)
    .eq("game_id", gameId);
  if (updateError) {
    await removeFrameByUrl(admin, url);
    return NextResponse.json({ error: "Unable to attach that image to the scene" }, { status: 500 });
  }

  await removeFrameByUrl(admin, previousUrl);
  return NextResponse.json({ slot, url }, { status: 201 });
}

/** Drop a scene's start or end still and put the slot back to "none". */
export async function DELETE(request: Request) {
  const parsed = clearSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { gameId, nodeId, slot } = parsed.data;
  const authorized = await authorize(gameId, nodeId);
  if ("error" in authorized) return authorized.error;
  const { admin, node } = authorized;

  const { error } = await admin
    .from("story_nodes")
    .update({
      [columnsForSlot[slot].url]: null,
      [columnsForSlot[slot].source]: "none",
      ...(slot === "start" ? { start_image_from_node_id: null } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", nodeId)
    .eq("game_id", gameId);
  if (error) return NextResponse.json({ error: "Unable to clear that frame" }, { status: 500 });

  await removeFrameByUrl(admin, slot === "start" ? node.start_image_url : node.end_image_url);
  return NextResponse.json({ slot, cleared: true });
}
