export type GameStatus = "draft" | "published";
export type RenderStatus = "draft" | "queued" | "rendering" | "ready" | "failed";
export type RenderResolution = "480P" | "768P";
export type SceneTone = "rain" | "greenhouse" | "archive" | "signal" | "dawn";

/**
 * Where a scene's opening or closing still comes from. `inherit` means "continue from the
 * previous scene", and is resolved at render time from that scene's extracted last frame
 * rather than copied, so re-rendering the parent updates the child automatically.
 */
export type FrameSource = "none" | "upload" | "inherit";
/** A scene can only continue from the shot before it, so an end frame is never inherited. */
export type EndFrameSource = Exclude<FrameSource, "inherit">;

export type StoryState = Record<string, string | number | boolean>;

/**
 * Who wrote a scene. Authored scenes are the story the creator built and published;
 * generated ones were improvised by infinite mode while somebody was playing, and are
 * deliberately invisible to the studio, to publishing, and to version snapshots.
 */
export type ContentOrigin = "authored" | "generated";

export interface StoryNode {
  id: string;
  title: string;
  eyebrow: string;
  narrative: string;
  videoPrompt: string;
  tone: SceneTone;
  durationSeconds: number;
  renderStatus: RenderStatus;
  videoUrl?: string;
  position: { x: number; y: number };
  origin: ContentOrigin;

  /** Author-set generation inputs. Chaining is opt-in, so both default to "none". */
  startImageSource: FrameSource;
  endImageSource: EndFrameSource;
  /** Only meaningful while the matching source is "upload". */
  startImageUrl?: string;
  endImageUrl?: string;
  /** Which earlier scene this one continues from, while startImageSource is "inherit". */
  startImageFromNodeId?: string;

  /**
   * Server-owned output: the final frame of {@link lastFrameSourceVideoUrl}, extracted
   * once and reused by every scene that continues from this one. Never sent on save.
   */
  lastFrameUrl?: string;
  lastFrameSourceVideoUrl?: string;
}

export interface StoryChoice {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  label: string;
  hint: string;
  conditions?: StoryState;
  stateEffects?: StoryState;
}

/**
 * One render attempt. Every attempt is kept, so a scene accumulates takes the author
 * can compare and choose between; the chosen take's url is mirrored onto the scene.
 */
export interface RenderJobUpdate {
  jobId: string;
  nodeId: string;
  status: RenderStatus;
  resolution: RenderResolution;
  /** The direction this take was generated from, which may differ from the scene's current prompt. */
  prompt: string;
  durationSeconds: number;
  createdAt: string;
  completedAt?: string;
  queuePosition?: number;
  logs: string[];
  message?: string;
  videoUrl?: string;
}

/**
 * A branch infinite mode is willing to offer, which may not have been walked yet.
 *
 * `toNodeId` is absent until some player takes it and pays for the scene behind it.
 * Once set, it is set for everyone: branches are canonical, so the second player down
 * this path replays a finished video instead of generating a new one.
 */
export interface GeneratedChoice {
  id: string;
  fromNodeId: string;
  label: string;
  hint: string;
  toNodeId?: string;
}

export interface StoryGame {
  id: string;
  slug: string;
  title: string;
  logline: string;
  description: string;
  creator: string;
  genre: string;
  status: GameStatus;
  startNodeId: string;
  storyBible: string;
  /** When true, the player is offered improvised branches wherever the author left off. */
  infiniteMode: boolean;
  nodes: StoryNode[];
  choices: StoryChoice[];
  updatedAt: string;
}

export interface Playthrough {
  gameId: string;
  currentNodeId: string;
  history: string[];
  state: StoryState;
}
