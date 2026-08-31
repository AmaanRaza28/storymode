"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SparklesIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { ScenePreview } from "@/components/story/scene-preview";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { applyChoice, getChoices, getNode } from "@/lib/story/engine";
import type { StoryGame, StoryState } from "@/lib/story/types";

export function StoryPlayer({ game }: { game: StoryGame }) {
  const [currentNodeId, setCurrentNodeId] = useState(game.startNodeId);
  const [history, setHistory] = useState<string[]>([game.startNodeId]);
  const [storyState, setStoryState] = useState<StoryState>({});
  const [progress, setProgress] = useState(0);
  const [muted, setMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(false);

  const currentNode = getNode(game, currentNodeId) ?? game.nodes[0];
  const choices = useMemo(
    () => getChoices(game, currentNode.id, storyState),
    [game, currentNode.id, storyState],
  );
  const choicesVisible = progress >= 48 || !currentNode.videoUrl;

  // Warm the branches the viewer can reach from here so the next cut is instant.
  const preloadUrls = useMemo(
    () => choices
      .map((choice) => getNode(game, choice.toNodeId)?.videoUrl)
      .filter((value): value is string => Boolean(value)),
    [choices, game],
  );

  // A rendered scene reports its own position; only an unrendered one needs a timer.
  useEffect(() => {
    if (currentNode.videoUrl || paused) return;
    const tickMs = 100;
    const totalMs = currentNode.durationSeconds * 1000;
    const interval = window.setInterval(() => {
      setProgress((value) => Math.min(100, value + (tickMs / totalMs) * 100));
    }, tickMs);
    return () => window.clearInterval(interval);
  }, [currentNode.id, currentNode.durationSeconds, currentNode.videoUrl, paused]);

  // Scenes loop, so take the furthest point reached: rewinding the video must not
  // re-lock choices the viewer has already been offered.
  const handleProgress = useCallback((percent: number) => {
    setProgress((value) => Math.max(value, percent));
  }, []);

  // Browsers only allow unmuted autoplay once the document has user activation, so
  // fall back to muted playback and surface a control the viewer can click for sound.
  const handleAutoplayBlocked = useCallback(() => {
    setMuted(true);
    setAudioBlocked(true);
  }, []);

  function toggleAudio() {
    setAudioBlocked(false);
    setMuted((value) => !value);
  }

  function togglePlayback() {
    setPaused((value) => !value);
  }

  function choose(choiceId: string) {
    const choice = choices.find((candidate) => candidate.id === choiceId);
    if (!choice) return;
    setStoryState((state) => applyChoice(state, choice));
    setCurrentNodeId(choice.toNodeId);
    setHistory((items) => [...items, choice.toNodeId]);
    setProgress(0);
  }

  function restart() {
    setCurrentNodeId(game.startNodeId);
    setHistory([game.startNodeId]);
    setStoryState({});
    setProgress(0);
  }

  function goBack() {
    if (history.length <= 1) return;
    const previousHistory = history.slice(0, -1);
    setHistory(previousHistory);
    setCurrentNodeId(previousHistory.at(-1) ?? game.startNodeId);
    setProgress(0);
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-primary text-primary-foreground">
      <ScenePreview
        node={currentNode}
        showCopy={false}
        muted={muted}
        paused={paused}
        preloadUrls={preloadUrls}
        onAutoplayBlocked={handleAutoplayBlocked}
        onProgress={handleProgress}
        onBufferingChange={setBuffering}
        className="absolute inset-0 min-h-screen rounded-none shadow-none"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-black/72 via-black/18 to-black/25" aria-hidden="true" />

      <header className="relative z-10 flex items-center justify-between gap-4 p-4 sm:p-6">
        <div className="flex items-center gap-2">
          <Link
            href="/"
            className={buttonVariants({ variant: "secondary", size: "icon-sm" })}
            aria-label="Exit player"
          >
            <ArrowLeftIcon />
          </Link>
          <Badge variant="secondary">{game.title}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {buffering && (
            <Badge variant="secondary" role="status" aria-live="polite">
              <Spinner data-icon="inline-start" />
              Loading scene
            </Badge>
          )}
          <Badge variant="secondary">
            <SparklesIcon data-icon="inline-start" />
            Scene {history.length}
          </Badge>
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label={paused ? "Play scene" : "Pause scene"}
            aria-pressed={paused}
            onClick={togglePlayback}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </Button>
          <Button
            variant="secondary"
            size={muted ? "sm" : "icon-sm"}
            aria-label={muted ? "Turn scene audio on" : "Mute scene audio"}
            aria-pressed={muted}
            onClick={toggleAudio}
          >
            {muted ? <VolumeXIcon data-icon="inline-start" /> : <Volume2Icon />}
            {muted && (audioBlocked ? "Tap for sound" : "Muted")}
          </Button>
        </div>
      </header>

      <div className="relative z-10 flex min-h-[calc(100vh-5rem)] items-end p-4 pb-8 sm:p-8 lg:p-12">
        <div className="grid w-full items-end gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(320px,440px)]">
          <section className="flex max-w-2xl flex-col gap-5">
            <Badge variant="secondary">{currentNode.eyebrow}</Badge>
            <div className="flex flex-col gap-3">
              <h1 className="text-4xl font-semibold tracking-[-0.04em] sm:text-6xl">{currentNode.title}</h1>
              <p className="max-w-xl text-base leading-relaxed text-white/75 sm:text-lg">{currentNode.narrative}</p>
            </div>
            <div className="max-w-md">
              <Progress value={progress} aria-label="Scene progress" />
            </div>
          </section>

          <section
            className="flex flex-col gap-3 rounded-2xl border border-white/15 bg-black/35 p-4 backdrop-blur-xl sm:p-5"
            aria-live="polite"
          >
            {choices.length > 0 ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">What should Mira do?</p>
                    <p className="text-xs text-white/60">Choose the next beat in the story.</p>
                  </div>
                  <span className="text-xs text-white/50">{choices.length} paths</span>
                </div>
                <div className="flex flex-col gap-2">
                  {choices.map((choice, index) => (
                    <Button
                      key={choice.id}
                      variant="secondary"
                      className="h-auto justify-between py-3 text-left"
                      disabled={!choicesVisible}
                      onClick={() => choose(choice.id)}
                    >
                      <span className="flex min-w-0 items-start gap-3">
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-background text-xs text-foreground">
                          {index + 1}
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="font-medium">{choice.label}</span>
                          <span className="truncate text-xs font-normal text-muted-foreground">{choice.hint}</span>
                        </span>
                      </span>
                      <ChevronRightIcon data-icon="inline-end" />
                    </Button>
                  ))}
                </div>
                {!choicesVisible && <p className="text-center text-xs text-white/55">Choices unlock as the scene reaches its decision point.</p>}
              </>
            ) : (
              <>
                <div>
                  <p className="font-medium">You reached this ending.</p>
                  <p className="text-xs text-white/60">Restart to discover another path through the signal.</p>
                </div>
                <Button variant="secondary" onClick={restart}>
                  <RotateCcwIcon data-icon="inline-start" />
                  Play again
                </Button>
              </>
            )}
            {history.length > 1 && (
              <Button variant="ghost" className="text-white hover:text-foreground" onClick={goBack}>
                <ArrowLeftIcon data-icon="inline-start" />
                Rewind one choice
              </Button>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
