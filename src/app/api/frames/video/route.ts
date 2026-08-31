import { NextResponse } from "next/server";
import { z } from "zod";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Stream a scene's video back from our own origin.
 *
 * Frame capture happens in the browser by drawing the video onto a canvas, and a canvas
 * that has drawn a cross-origin frame cannot be read back. Rather than depend on fal's
 * CDN sending permissive CORS headers, the studio pulls the video through here, turns it
 * into a blob url, and reads the canvas without the origin ever being in question.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId") ?? "";
  const nodeId = url.searchParams.get("nodeId") ?? "";
  if (!z.uuid().safeParse(gameId).success || !z.uuid().safeParse(nodeId).success) {
    return NextResponse.json({ error: "Invalid game or scene" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) {
    return NextResponse.json({ error: "Supabase is not configured" }, { status: 500 });
  }

  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { data: ownedGame } = await supabase
    .from("games")
    .select("id")
    .eq("id", gameId)
    .eq("creator_id", authData.user.id)
    .maybeSingle();
  if (!ownedGame) {
    return NextResponse.json({ error: "Game not found or not owned by you" }, { status: 403 });
  }

  const { data: node } = await admin
    .from("story_nodes")
    .select("video_url")
    .eq("id", nodeId)
    .eq("game_id", gameId)
    .maybeSingle();
  const videoUrl = (node as { video_url: string | null } | null)?.video_url;
  if (!videoUrl) return NextResponse.json({ error: "This scene has no video yet" }, { status: 404 });

  const upstream = await fetch(videoUrl).catch(() => null);
  if (!upstream?.ok || !upstream.body) {
    return NextResponse.json({ error: "Unable to read this scene's video" }, { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "video/mp4",
      ...(upstream.headers.get("content-length")
        ? { "content-length": upstream.headers.get("content-length") as string }
        : {}),
      // Only ever read back by the author who owns the story.
      "cache-control": "private, max-age=300",
    },
  });
}
