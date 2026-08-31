"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { StoryGame } from "@/lib/story/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface StoryActionState {
  status: "idle" | "error" | "success";
  message?: string;
}

const createSchema = z.object({
  title: z.string().trim().min(1, "Give your story a title").max(120),
  idea: z.string().trim().min(10, "Describe the premise in a little more detail").max(1000),
});

const deleteSchema = z.object({
  gameId: z.uuid(),
});

const infiniteModeSchema = z.object({
  gameId: z.uuid(),
  enabled: z.boolean(),
});

const stateValue = z.union([z.string(), z.number(), z.boolean()]);
const gameSchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1).max(160),
  title: z.string().trim().min(1).max(120),
  logline: z.string().max(1000),
  description: z.string().max(10000),
  creator: z.string(),
  genre: z.string().max(120),
  status: z.enum(["draft", "published"]),
  startNodeId: z.uuid(),
  storyBible: z.string().max(20000),
  updatedAt: z.string(),
  nodes: z.array(z.object({
    id: z.uuid(),
    title: z.string().min(1).max(160),
    eyebrow: z.string().max(160),
    narrative: z.string().max(10000),
    videoPrompt: z.string().max(7000),
    tone: z.enum(["rain", "greenhouse", "archive", "signal", "dawn"]),
    durationSeconds: z.number().int().min(5).max(15),
    renderStatus: z.enum(["draft", "queued", "rendering", "ready", "failed"]),
    videoUrl: z.url().optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    // Frame chaining is deliberately lenient here: autosave fires mid-edit, so a scene
    // set to "inherit" before its source scene has been picked must still save. Whether
    // a frame is actually usable is decided when the render is submitted.
    startImageSource: z.enum(["none", "upload", "inherit"]).default("none"),
    endImageSource: z.enum(["none", "upload"]).default("none"),
    startImageUrl: z.url().optional(),
    endImageUrl: z.url().optional(),
    startImageFromNodeId: z.uuid().optional(),
  })).min(1).max(500),
  choices: z.array(z.object({
    id: z.uuid(),
    fromNodeId: z.uuid(),
    toNodeId: z.uuid(),
    label: z.string().min(1).max(160),
    hint: z.string().max(500),
    conditions: z.record(z.string(), stateValue).optional(),
    stateEffects: z.record(z.string(), stateValue).optional(),
  })).max(2000),
});

function slugify(title: string) {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `${base || "untitled-story"}-${randomUUID().slice(0, 6)}`;
}

export async function createStoryAction(
  _previous: StoryActionState,
  formData: FormData,
): Promise<StoryActionState> {
  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "error", message: "Supabase is not configured." };
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { status: "error", message: "Sign in before creating a story." };

  const slug = slugify(parsed.data.title);
  const { error } = await supabase.rpc("create_story_game", {
    p_title: parsed.data.title,
    p_logline: parsed.data.idea,
    p_slug: slug,
  });
  if (error) return { status: "error", message: error.message };
  redirect(`/studio/${slug}`);
}

export async function deleteStoryAction(
  _previous: StoryActionState,
  formData: FormData,
): Promise<StoryActionState> {
  const parsed = deleteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { status: "error", message: "Invalid story." };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "error", message: "Supabase is not configured." };
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { status: "error", message: "Your session expired. Sign in again." };

  const { data, error } = await supabase
    .from("games")
    .delete()
    .eq("id", parsed.data.gameId)
    .eq("creator_id", userData.user.id)
    .select("id")
    .maybeSingle();

  if (error) return { status: "error", message: error.message };
  if (!data) return { status: "error", message: "Story not found or you do not have permission to delete it." };

  revalidatePath("/");
  return { status: "success", message: "Story deleted." };
}

/**
 * Turn infinite mode on or off for a story.
 *
 * Deliberately not part of save_story_game: that call rewrites the authored graph, and
 * this is a property of the story rather than of the graph. Keeping it separate also
 * means an autosave carrying a stale copy of the flag can never flip it back.
 */
export async function setInfiniteModeAction(
  gameId: string,
  enabled: boolean,
): Promise<StoryActionState> {
  const parsed = infiniteModeSchema.safeParse({ gameId, enabled });
  if (!parsed.success) return { status: "error", message: "Invalid story." };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "error", message: "Supabase is not configured." };
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { status: "error", message: "Your session expired. Sign in again." };

  const { data, error } = await supabase
    .from("games")
    .update({ infinite_mode: parsed.data.enabled })
    .eq("id", parsed.data.gameId)
    .eq("creator_id", userData.user.id)
    .select("id")
    .maybeSingle();

  if (error) return { status: "error", message: error.message };
  if (!data) return { status: "error", message: "Story not found or not owned by you." };

  return {
    status: "success",
    message: parsed.data.enabled ? "Infinite mode on" : "Infinite mode off",
  };
}

export async function saveStoryAction(
  game: StoryGame,
  options?: { revalidate?: boolean },
): Promise<StoryActionState> {
  const parsed = gameSchema.safeParse(game);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid story graph" };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { status: "error", message: "Supabase is not configured." };
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return { status: "error", message: "Your session expired. Sign in again." };

  const { error } = await supabase.rpc("save_story_game", {
    p_game_id: parsed.data.id,
    p_title: parsed.data.title,
    p_logline: parsed.data.logline,
    p_description: parsed.data.description,
    p_genre: parsed.data.genre,
    p_story_bible: parsed.data.storyBible,
    p_status: parsed.data.status,
    p_start_node_id: parsed.data.startNodeId,
    p_nodes: parsed.data.nodes,
    p_choices: parsed.data.choices,
  });
  if (error) return { status: "error", message: error.message };

  // Autosaves skip revalidation: they fire while the author types, and refreshing
  // the route on every keystroke pause would churn the router cache for no gain.
  if (options?.revalidate) {
    revalidatePath("/");
    revalidatePath(`/studio/${parsed.data.slug}`);
    revalidatePath(`/play/${parsed.data.slug}`);
  }
  return { status: "success", message: "Saved" };
}
