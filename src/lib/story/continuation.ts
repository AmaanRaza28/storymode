import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import type { SceneTone } from "@/lib/story/types";

/**
 * The story-writing half of infinite mode.
 *
 * Two things get asked of the model, and they are deliberately separate calls. Offering
 * branches is cheap and happens at every scene, so it runs while the current clip is
 * still playing. Writing the scene behind a branch only happens once somebody commits
 * to it, because the scene it produces is about to be turned into a video that costs
 * real money.
 *
 * GPT-5.6 Luna is the model for both: this is high-volume, latency-sensitive, and
 * strictly structured, which is what it is built for. At $0.20/$1.20 per million tokens
 * the text is rounding error next to the $0.25 clip it precedes.
 */
const MODEL = "gpt-5.6-luna";

/** Scene beats are short; reasoning past this buys nothing and costs latency. */
const MAX_OUTPUT_TOKENS = 2000;

const TONES = ["rain", "greenhouse", "archive", "signal", "dawn"] as const;

/** Enough recent story for continuity without re-sending a long playthrough every turn. */
const PATH_WINDOW = 6;

export interface StoryBeat {
  title: string;
  narrative: string;
}

export interface ContinuationContext {
  title: string;
  genre: string;
  logline: string;
  storyBible: string;
  /** Oldest first. Only the tail is sent. */
  path: StoryBeat[];
}

const branchesSchema = z.object({
  choices: z
    .array(
      z.object({
        label: z
          .string()
          .describe("What the player does next, in 2-6 words, phrased as an action."),
        hint: z
          .string()
          .describe("One short clause hinting at the risk or promise of taking it."),
      }),
    )
    .min(2)
    .max(3),
});

const sceneSchema = z.object({
  title: z.string().describe("The scene's title, 2-5 words."),
  eyebrow: z
    .string()
    .describe("A short location or time stamp shown above the title, like 'Sublevel 3 · 04:12'."),
  narrative: z
    .string()
    .describe("Two or three sentences of present-tense prose describing what happens."),
  videoPrompt: z
    .string()
    .describe(
      "A single-shot cinematic prompt for a text-to-video model: subject, action, " +
        "camera move, lighting, mood. No dialogue, no cuts, no scene numbers.",
    ),
  tone: z.enum(TONES),
});

export interface GeneratedScene {
  title: string;
  eyebrow: string;
  narrative: string;
  videoPrompt: string;
  tone: SceneTone;
}

export type BranchOption = z.infer<typeof branchesSchema>["choices"][number];

function systemPrompt(context: ContinuationContext) {
  return [
    "You continue an interactive cinematic story that has run past what its author wrote.",
    "You are writing inside someone else's world: honour its established tone, characters,",
    "and rules, and never contradict what has already happened.",
    "",
    `Story: ${context.title}`,
    context.genre ? `Genre: ${context.genre}` : "",
    context.logline ? `Logline: ${context.logline}` : "",
    context.storyBible ? `\nStory bible:\n${context.storyBible}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function pathSummary(path: StoryBeat[]) {
  const recent = path.slice(-PATH_WINDOW);
  if (!recent.length) return "The story has not started yet.";
  return recent
    .map((beat, index) => `${index + 1}. ${beat.title}\n   ${beat.narrative}`)
    .join("\n");
}

/**
 * Invent the branches on offer at a scene.
 *
 * `existingLabels` are branches already minted here by earlier players. They are passed
 * in to be avoided rather than filtered out afterwards: a near-duplicate that survives
 * normalisation would collide on the unique index and be silently dropped, leaving the
 * player with fewer choices than they were promised.
 */
export async function generateBranches(
  context: ContinuationContext,
  existingLabels: string[] = [],
): Promise<BranchOption[]> {
  const avoid = existingLabels.length
    ? `\n\nThese branches already exist here. Offer genuinely different ones, and do not ` +
      `restate them in other words:\n${existingLabels.map((label) => `- ${label}`).join("\n")}`
    : "";

  const { object } = await generateObject({
    model: openai(MODEL),
    schema: branchesSchema,
    system: systemPrompt(context),
    prompt:
      `The story so far:\n${pathSummary(context.path)}\n\n` +
      `Offer the player two or three things they could do next. Each must lead somewhere ` +
      `materially different — not three phrasings of the same move — and each must be ` +
      `something that could plausibly be shown in a single five-second shot.${avoid}`,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    providerOptions: {
      // This runs while the current scene is still playing, so it is on the player's
      // critical path. Minimal reasoning; the task is short-form and well constrained.
      openai: { reasoningEffort: "low", textVerbosity: "low" },
    },
  });

  return object.choices;
}

/** Write the scene that a chosen branch leads to. */
export async function generateScene(
  context: ContinuationContext,
  chosenLabel: string,
  chosenHint: string,
): Promise<GeneratedScene> {
  const { object } = await generateObject({
    model: openai(MODEL),
    schema: sceneSchema,
    system: systemPrompt(context),
    prompt:
      `The story so far:\n${pathSummary(context.path)}\n\n` +
      `The player just chose: "${chosenLabel}"${chosenHint ? ` — ${chosenHint}` : ""}.\n\n` +
      `Write the single scene that follows. It is one continuous five-second shot, so it ` +
      `must show one action in one place — no cuts, no time skips, no montage. Move the ` +
      `story somewhere new rather than restating what just happened.`,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    providerOptions: {
      // The player is waiting on this before the video can even be submitted, but the
      // prompt it writes decides what the clip looks like — worth a step up from `low`.
      openai: { reasoningEffort: "medium", textVerbosity: "low" },
    },
  });

  return object;
}

export function isContinuationConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}
