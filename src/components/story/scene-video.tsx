"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Slot = 0 | 1;

const SLOTS: readonly Slot[] = [0, 1];
/** Enough to cover the branches on screen without pulling the whole story down at once. */
const MAX_WARM_VIDEOS = 3;

interface SceneVideoProps {
  url: string;
  muted?: boolean;
  paused?: boolean;
  /** Videos for the reachable next scenes, fetched early so a cut does not have to buffer. */
  preloadUrls?: string[];
  onAutoplayBlocked?: () => void;
  onProgress?: (percent: number) => void;
  onBufferingChange?: (buffering: boolean) => void;
}

/**
 * Plays a scene across two buffers. Swapping `src` on a single element blanks it to the
 * background for as long as the next file takes to load, so the outgoing scene keeps the
 * screen until the incoming one can actually paint a frame.
 */
export function SceneVideo({
  url,
  muted = false,
  paused = false,
  preloadUrls = [],
  onAutoplayBlocked,
  onProgress,
  onBufferingChange,
}: SceneVideoProps) {
  // Which buffer is on screen, what it is showing, and whether it can paint yet. The other
  // buffer is whatever the caller is asking for next, so both derive from this one state.
  const [active, setActive] = useState<{ slot: Slot; url: string; ready: boolean }>({
    slot: 0,
    url,
    ready: false,
  });
  const firstRef = useRef<HTMLVideoElement>(null);
  const secondRef = useRef<HTMLVideoElement>(null);

  const incomingSlot: Slot = active.slot === 0 ? 1 : 0;
  const incomingUrl = url === active.url ? null : url;
  const slots: [string | null, string | null] = active.slot === 0
    ? [active.url, incomingUrl]
    : [incomingUrl, active.url];

  useEffect(() => {
    onBufferingChange?.(incomingUrl !== null || !active.ready);
    // A scene with no render at all unmounts this component, so hand the flag back
    // rather than leaving the caller reporting a load that nothing is doing.
    return () => onBufferingChange?.(false);
  }, [incomingUrl, active.ready, onBufferingChange]);

  // React omits `muted` from server HTML and can skip it on hydration, so mute state and
  // playback are both driven from the element rather than from props alone.
  useEffect(() => {
    const element = (active.slot === 0 ? firstRef : secondRef).current;
    if (!element) return;
    element.muted = muted;
    element.volume = 1;
    if (paused) {
      element.pause();
      return;
    }
    element.play().catch(() => {
      if (!muted) onAutoplayBlocked?.();
    });
  }, [active, muted, paused, onAutoplayBlocked]);

  /**
   * A buffer that can paint takes the screen. An unloadable one takes it too, otherwise
   * the viewer keeps watching the previous scene under the new scene's text.
   */
  function handleReadiness(slot: Slot) {
    if (slot === incomingSlot && incomingUrl !== null) {
      setActive({ slot, url: incomingUrl, ready: true });
      return;
    }
    if (slot === active.slot && !active.ready) {
      setActive({ slot, url: active.url, ready: true });
    }
  }

  function reportProgress(slot: Slot) {
    // Only the scene the caller is asking for reports progress; the outgoing one is still
    // playing during a cut and would unlock the next scene's choices early.
    if (slot !== active.slot || active.url !== url) return;
    const element = (slot === 0 ? firstRef : secondRef).current;
    if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return;
    onProgress?.(Math.min(100, (element.currentTime / element.duration) * 100));
  }

  const warmUrls = preloadUrls
    .filter((candidate) => candidate !== slots[0] && candidate !== slots[1])
    .slice(0, MAX_WARM_VIDEOS);

  return (
    <>
      {SLOTS.map((slot) => {
        const slotUrl = slots[slot];
        if (!slotUrl) return null;
        const isActive = slot === active.slot;
        return (
          <video
            key={slot}
            ref={slot === 0 ? firstRef : secondRef}
            className={cn(
              "absolute inset-0 size-full object-cover",
              isActive ? "opacity-100" : "opacity-0",
            )}
            src={slotUrl}
            autoPlay={isActive && !paused}
            playsInline
            muted={muted}
            preload="auto"
            aria-hidden={isActive ? undefined : true}
            onCanPlay={() => handleReadiness(slot)}
            onError={() => handleReadiness(slot)}
            onTimeUpdate={() => reportProgress(slot)}
          />
        );
      })}
      {warmUrls.map((warmUrl) => (
        <video
          key={warmUrl}
          className="pointer-events-none absolute size-0 opacity-0"
          src={warmUrl}
          preload="auto"
          muted
          playsInline
          tabIndex={-1}
          aria-hidden="true"
        />
      ))}
    </>
  );
}
