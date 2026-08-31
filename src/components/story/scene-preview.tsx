"use client";

import { FilmIcon, RadioIcon } from "lucide-react";
import { SceneVideo } from "@/components/story/scene-video";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StoryNode } from "@/lib/story/types";

interface ScenePreviewProps {
  node: StoryNode;
  className?: string;
  showCopy?: boolean;
  /** H3 Max renders native audio, so scenes play unmuted unless the caller mutes them. */
  muted?: boolean;
  paused?: boolean;
  /** Videos for the reachable next scenes, warmed so a cut does not have to buffer. */
  preloadUrls?: string[];
  /** Fired when the browser refuses unmuted autoplay, so the caller can fall back to muted. */
  onAutoplayBlocked?: () => void;
  /** Playback position of the current scene, 0-100. */
  onProgress?: (percent: number) => void;
  /** True while the next scene is still loading behind the one on screen. */
  onBufferingChange?: (buffering: boolean) => void;
}

export function ScenePreview({
  node,
  className,
  showCopy = true,
  muted = false,
  paused = false,
  preloadUrls,
  onAutoplayBlocked,
  onProgress,
  onBufferingChange,
}: ScenePreviewProps) {
  return (
    <div
      className={cn(
        "relative isolate flex min-h-72 overflow-hidden rounded-2xl bg-primary text-primary-foreground shadow-2xl shadow-foreground/15",
        className,
      )}
    >
      {node.videoUrl ? (
        <SceneVideo
          url={node.videoUrl}
          muted={muted}
          paused={paused}
          preloadUrls={preloadUrls}
          onAutoplayBlocked={onAutoplayBlocked}
          onProgress={onProgress}
          onBufferingChange={onBufferingChange}
        />
      ) : (
        <div className={cn("scene-backdrop", `scene-tone-${node.tone}`)} aria-hidden="true" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/10 to-black/25" aria-hidden="true" />
      <div className="relative mt-auto flex w-full flex-col gap-4 p-6 sm:p-8">
        <div className="flex items-center justify-between gap-3">
          <Badge variant="secondary">
            <RadioIcon data-icon="inline-start" />
            {node.eyebrow}
          </Badge>
          <span className="flex items-center gap-1.5 text-xs text-white/70">
            <FilmIcon aria-hidden="true" />
            {node.durationSeconds}s scene
          </span>
        </div>
        {showCopy && (
          <div className="flex max-w-2xl flex-col gap-2">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-4xl">{node.title}</h2>
            <p className="text-sm leading-relaxed text-white/78 sm:text-base">{node.narrative}</p>
          </div>
        )}
      </div>
    </div>
  );
}

