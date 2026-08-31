import type {
  EndFrameSource,
  FrameSource,
  StoryChoice,
  StoryGame,
  StoryNode,
} from "@/lib/story/types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type GameRow = {
  id: string;
  creator_id: string;
  slug: string;
  title: string;
  logline: string;
  description: string;
  genre: string;
  status: "draft" | "published";
  start_node_id: string | null;
  story_bible: unknown;
  infinite_mode: boolean;
  updated_at: string;
};

type NodeRow = {
  id: string;
  title: string;
  eyebrow: string;
  narrative: string;
  video_prompt: string;
  tone: string;
  duration_seconds: number;
  render_status: StoryNode["renderStatus"];
  video_url: string | null;
  position_x: number;
  position_y: number;
  start_image_source: FrameSource;
  end_image_source: EndFrameSource;
  start_image_url: string | null;
  end_image_url: string | null;
  start_image_from_node_id: string | null;
  last_frame_url: string | null;
  last_frame_source_video_url: string | null;
};

type ChoiceRow = {
  id: string;
  from_node_id: string;
  to_node_id: string;
  label: string;
  hint: string;
  conditions: StoryChoice["conditions"];
  state_effects: StoryChoice["stateEffects"];
};

const tones = new Set<StoryNode["tone"]>(["rain", "greenhouse", "archive", "signal", "dawn"]);
const frameSources = new Set<FrameSource>(["none", "upload", "inherit"]);

/** Columns a scene is read back with, shared by every query that rebuilds the graph. */
const nodeColumns =
  "id,title,eyebrow,narrative,video_prompt,tone,duration_seconds,render_status,video_url," +
  "position_x,position_y,start_image_source,end_image_source,start_image_url,end_image_url," +
  "start_image_from_node_id,last_frame_url,last_frame_source_video_url";

function storyBibleText(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") {
    return value.text;
  }
  return "";
}

export async function getStoryGameBySlug(slug: string): Promise<StoryGame | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;

  const { data: rawGame, error } = await supabase
    .from("games")
    .select("id,creator_id,slug,title,logline,description,genre,status,start_node_id,story_bible,infinite_mode,updated_at")
    .eq("slug", slug)
    .maybeSingle();
  if (error || !rawGame) return null;
  const game = rawGame as GameRow;

  const [nodesResult, choicesResult, profileResult] = await Promise.all([
    // Only the authored graph is loaded here. Infinite mode's scenes are discovered a
    // branch at a time through /api/infinite: a story that has been played for a while
    // can hold thousands of them, and none are reachable until their branch is taken.
    supabase
      .from("story_nodes")
      .select(nodeColumns)
      .eq("game_id", game.id)
      .eq("origin", "authored")
      .order("created_at"),
    supabase
      .from("story_choices")
      .select("id,from_node_id,to_node_id,label,hint,conditions,state_effects")
      .eq("game_id", game.id)
      .order("created_at"),
    supabase.from("profiles").select("display_name,username").eq("id", game.creator_id).maybeSingle(),
  ]);
  if (nodesResult.error || choicesResult.error || !nodesResult.data?.length) return null;

  const nodes = (nodesResult.data as unknown as NodeRow[]).map<StoryNode>((node) => ({
    id: node.id,
    title: node.title,
    eyebrow: node.eyebrow,
    narrative: node.narrative,
    videoPrompt: node.video_prompt,
    tone: tones.has(node.tone as StoryNode["tone"]) ? (node.tone as StoryNode["tone"]) : "signal",
    durationSeconds: node.duration_seconds,
    renderStatus: node.render_status,
    ...(node.video_url ? { videoUrl: node.video_url } : {}),
    position: { x: node.position_x, y: node.position_y },
    origin: "authored",
    startImageSource: frameSources.has(node.start_image_source) ? node.start_image_source : "none",
    // 'inherit' is rejected by a check constraint on the column, so anything unexpected
    // here reads as "no end frame" rather than as a start-frame source.
    endImageSource: node.end_image_source === "upload" ? "upload" : "none",
    ...(node.start_image_url ? { startImageUrl: node.start_image_url } : {}),
    ...(node.end_image_url ? { endImageUrl: node.end_image_url } : {}),
    ...(node.start_image_from_node_id ? { startImageFromNodeId: node.start_image_from_node_id } : {}),
    ...(node.last_frame_url ? { lastFrameUrl: node.last_frame_url } : {}),
    ...(node.last_frame_source_video_url
      ? { lastFrameSourceVideoUrl: node.last_frame_source_video_url }
      : {}),
  }));
  const choices = (choicesResult.data as ChoiceRow[]).map<StoryChoice>((choice) => ({
    id: choice.id,
    fromNodeId: choice.from_node_id,
    toNodeId: choice.to_node_id,
    label: choice.label,
    hint: choice.hint,
    conditions: choice.conditions ?? {},
    stateEffects: choice.state_effects ?? {},
  }));
  const profile = profileResult.data as { display_name: string | null; username: string } | null;

  return {
    id: game.id,
    slug: game.slug,
    title: game.title,
    logline: game.logline,
    description: game.description,
    creator: profile?.display_name || profile?.username || "Storymode creator",
    genre: game.genre,
    status: game.status,
    startNodeId: game.start_node_id ?? nodes[0].id,
    storyBible: storyBibleText(game.story_bible),
    infiniteMode: game.infinite_mode,
    nodes,
    choices,
    updatedAt: new Date(game.updated_at).toLocaleString(),
  };
}

export interface StorySummary {
  id: string;
  slug: string;
  title: string;
  logline: string;
  status: "draft" | "published";
  updatedAt: string;
  sceneCount: number;
}

export interface OwnedStoriesResult {
  stories: StorySummary[];
  error?: string;
}

export async function listOwnedStories(userId: string): Promise<OwnedStoriesResult> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { stories: [], error: "Story storage is not configured." };
  const { data, error } = await supabase
    .from("games")
    .select("id,slug,title,logline,status,updated_at,scene_count:story_nodes!story_nodes_game_id_fkey(count)")
    .eq("creator_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("Failed to list owned stories", error);
    return {
      stories: [],
      error: "We couldn't load your stories. Refresh the page and try again.",
    };
  }

  return {
    stories: (data ?? []).map((row) => ({
      id: row.id as string,
      slug: row.slug as string,
      title: row.title as string,
      logline: row.logline as string,
      status: row.status as "draft" | "published",
      updatedAt: new Date(row.updated_at as string).toLocaleString(),
      sceneCount: Number((row.scene_count as { count: number }[] | undefined)?.[0]?.count ?? 0),
    })),
  };
}
