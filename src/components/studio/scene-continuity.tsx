"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImageIcon, RefreshCwIcon, UploadIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { captureSceneLastFrame } from "@/lib/story/capture-frame";
import type { StoryGame, StoryNode } from "@/lib/story/types";
import { cn } from "@/lib/utils";

/**
 * How usable the still a scene wants to open on currently is. This drives both the
 * badge the author sees and whether the studio quietly captures a frame for them.
 */
type InheritState = "unset" | "needs-render" | "needs-capture" | "capturing" | "ready" | "failed";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface SceneContinuityProps {
  game: StoryGame;
  node: StoryNode;
  /** An author edit: marks the graph dirty so autosave persists it. */
  onEdit: (updates: Partial<StoryNode>) => void;
  /** Already persisted by the server; mirrored locally without marking the graph dirty. */
  onSync: (nodeId: string, updates: Partial<StoryNode>) => void;
}

function FramePreview({ url, alt }: { url: string; alt: string }) {
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-muted">
      {/* Stills live in a public Supabase bucket, so a plain img avoids loader config. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt} className="absolute inset-0 size-full object-cover" />
    </div>
  );
}

function EmptyFrame({ label }: { label: string }) {
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/40 px-4 text-center">
      <ImageIcon aria-hidden="true" className="text-muted-foreground" />
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export function SceneContinuity({ game, node, onEdit, onSync }: SceneContinuityProps) {
  const [busy, setBusy] = useState<"start" | "end" | null>(null);
  const [captureState, setCaptureState] = useState<"idle" | "capturing" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const startInputRef = useRef<HTMLInputElement>(null);
  const endInputRef = useRef<HTMLInputElement>(null);
  /** Videos already attempted, so a failed capture is not retried on every render. */
  const attemptedRef = useRef(new Set<string>());

  // Only scenes that actually lead here can be continued from — "the previous scene" has
  // no meaning for a scene the player can never arrive from.
  const parents = Array.from(
    new Map(
      game.choices
        .filter((choice) => choice.toNodeId === node.id)
        .map((choice) => game.nodes.find((candidate) => candidate.id === choice.fromNodeId))
        .filter((candidate): candidate is StoryNode => Boolean(candidate))
        .map((candidate) => [candidate.id, candidate]),
    ).values(),
  );

  const sourceNode = node.startImageFromNodeId
    ? game.nodes.find((candidate) => candidate.id === node.startImageFromNodeId)
    : undefined;

  // Deleting the branch that led here does not silently drop the frame the scene was
  // built on, so a source that is no longer a parent is still offered — labelled, so the
  // author can see the graph moved underneath it.
  const orphanedSource = sourceNode && !parents.some((parent) => parent.id === sourceNode.id)
    ? sourceNode
    : undefined;
  const sourceOptions = orphanedSource ? [...parents, orphanedSource] : parents;

  const sourceFrameIsFresh = Boolean(
    sourceNode?.videoUrl
    && sourceNode.lastFrameUrl
    && sourceNode.lastFrameSourceVideoUrl === sourceNode.videoUrl,
  );

  let inheritState: InheritState = "unset";
  if (sourceNode) {
    if (!sourceNode.videoUrl) inheritState = "needs-render";
    else if (sourceFrameIsFresh) inheritState = "ready";
    else if (captureState === "capturing") inheritState = "capturing";
    else if (captureState === "failed") inheritState = "failed";
    else inheritState = "needs-capture";
  }

  const captureFrom = useCallback(async (target: StoryNode) => {
    if (!target.videoUrl) return;
    setCaptureState("capturing");
    setError(null);
    try {
      const blob = await captureSceneLastFrame(game.id, target.id);
      const form = new FormData();
      form.set("gameId", game.id);
      form.set("nodeId", target.id);
      form.set("slot", "last");
      form.set("sourceVideoUrl", target.videoUrl);
      form.set("file", new File([blob], "last-frame.jpg", { type: "image/jpeg" }));

      const response = await fetch("/api/frames", { method: "POST", body: form });
      const body = await response.json() as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? "Unable to store the captured frame");

      // Persisted server-side already, so this is a mirror rather than an edit.
      onSync(target.id, { lastFrameUrl: body.url, lastFrameSourceVideoUrl: target.videoUrl });
      setCaptureState("idle");
    } catch (caught) {
      setCaptureState("failed");
      setError(caught instanceof Error ? caught.message : "Unable to capture that frame");
    }
  }, [game.id, onSync]);

  // Capture without being asked: by the time the author reaches "Generate", the still
  // they picked should already exist. Keyed by video so a scene moved onto a different
  // take is re-captured, and a failure is not retried in a loop.
  useEffect(() => {
    if (node.startImageSource !== "inherit") return;
    if (!sourceNode?.videoUrl || sourceFrameIsFresh) return;
    const key = `${sourceNode.id}:${sourceNode.videoUrl}`;
    if (attemptedRef.current.has(key)) return;
    attemptedRef.current.add(key);
    void captureFrom(sourceNode);
  }, [captureFrom, node.startImageSource, sourceFrameIsFresh, sourceNode]);

  async function uploadFrame(slot: "start" | "end", file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setError("Images must be 10MB or smaller");
      return;
    }
    setBusy(slot);
    setError(null);
    try {
      const form = new FormData();
      form.set("gameId", game.id);
      form.set("nodeId", node.id);
      form.set("slot", slot);
      form.set("file", file);

      const response = await fetch("/api/frames", { method: "POST", body: form });
      const body = await response.json() as { url?: string; error?: string };
      if (!response.ok || !body.url) throw new Error(body.error ?? "Upload failed");

      onSync(node.id, slot === "start"
        ? { startImageSource: "upload", startImageUrl: body.url, startImageFromNodeId: undefined }
        : { endImageSource: "upload", endImageUrl: body.url });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  /**
   * Drop a stored still.
   *
   * `resetSource` is false when the author is switching to a different source rather
   * than clearing outright: the delete still has to happen so the object is not
   * orphaned, but mirroring the route's "source is now none" back into local state
   * would overwrite the source they just chose. The pending edit reconciles the row on
   * the next autosave, which the render path flushes before submitting anything.
   */
  async function clearFrame(slot: "start" | "end", { resetSource = true } = {}) {
    setBusy(slot);
    setError(null);
    try {
      const response = await fetch("/api/frames", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: game.id, nodeId: node.id, slot }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? "Unable to clear that frame");
      }
      if (resetSource) {
        onSync(node.id, slot === "start"
          ? { startImageSource: "none", startImageUrl: undefined, startImageFromNodeId: undefined }
          : { endImageSource: "none", endImageUrl: undefined });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to clear that frame");
    } finally {
      setBusy(null);
    }
  }

  function changeStartSource(value: StoryNode["startImageSource"]) {
    if (value === "upload") {
      // The picker is what actually sets 'upload', once a file exists to point at.
      startInputRef.current?.click();
      return;
    }
    if (node.startImageSource === "upload" && node.startImageUrl) {
      void clearFrame("start", { resetSource: false });
    }
    setCaptureState("idle");
    onEdit(value === "inherit"
      // One parent means there is nothing to disambiguate, so pick it for them.
      ? { startImageSource: "inherit", startImageUrl: undefined, startImageFromNodeId: node.startImageFromNodeId ?? parents[0]?.id }
      : { startImageSource: "none", startImageUrl: undefined, startImageFromNodeId: undefined });
  }

  const inheritBadge: Record<InheritState, { label: string; tone: "outline" | "secondary" | "destructive" }> = {
    unset: { label: "Pick a scene", tone: "outline" },
    "needs-render": { label: "Source not generated", tone: "outline" },
    "needs-capture": { label: "Frame not captured", tone: "outline" },
    capturing: { label: "Capturing frame", tone: "outline" },
    ready: { label: "Frame ready", tone: "secondary" },
    failed: { label: "Capture failed", tone: "destructive" },
  };

  const startPreviewUrl = node.startImageSource === "upload"
    ? node.startImageUrl
    : node.startImageSource === "inherit" && sourceFrameIsFresh
      ? sourceNode?.lastFrameUrl
      : undefined;

  return (
    <div className="flex flex-col gap-5">
      <input
        ref={startInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void uploadFrame("start", file);
        }}
      />
      <input
        ref={endInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void uploadFrame("end", file);
        }}
      />

      <Field>
        <FieldLabel htmlFor="start-frame-source">Opening frame</FieldLabel>
        <Select
          value={node.startImageSource}
          onValueChange={(value) => changeStartSource(value as StoryNode["startImageSource"])}
        >
          <SelectTrigger id="start-frame-source" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="none">Start fresh · generated from the direction alone</SelectItem>
              <SelectItem value="inherit" disabled={parents.length === 0}>
                Continue from the previous scene
              </SelectItem>
              <SelectItem value="upload">Upload my own image…</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          {parents.length === 0 && node.startImageSource === "none"
            ? "Branch into this scene on the canvas to continue from the shot before it."
            : "The still this shot opens on. Continuity is off unless you turn it on here."}
        </FieldDescription>
      </Field>

      {node.startImageSource === "inherit" && (
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
          <Field>
            <FieldLabel htmlFor="start-frame-source-node">Continue from</FieldLabel>
            <Select
              value={node.startImageFromNodeId ?? ""}
              onValueChange={(value) => {
                setCaptureState("idle");
                onEdit({ startImageFromNodeId: value ?? undefined });
              }}
            >
              <SelectTrigger id="start-frame-source-node" className="w-full">
                <SelectValue placeholder="Choose a scene" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {sourceOptions.map((parent) => (
                    <SelectItem key={parent.id} value={parent.id}>
                      {parent.title || "Untitled scene"}
                      {parent.id === orphanedSource?.id ? " · no longer branches here" : ""}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {parents.length > 1 && (
              <FieldDescription>
                {parents.length} scenes lead here, so pick which one this continues from.
              </FieldDescription>
            )}
          </Field>

          <div className="flex items-center justify-between gap-2">
            <Badge variant={inheritBadge[inheritState].tone}>
              {inheritState === "capturing" && <Spinner data-icon="inline-start" />}
              {inheritBadge[inheritState].label}
            </Badge>
            {sourceNode?.videoUrl && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void captureFrom(sourceNode)}
                disabled={captureState === "capturing"}
              >
                <RefreshCwIcon data-icon="inline-start" />
                {sourceFrameIsFresh ? "Recapture" : "Capture now"}
              </Button>
            )}
          </div>

          {startPreviewUrl ? (
            <FramePreview url={startPreviewUrl} alt={`Last frame of ${sourceNode?.title ?? "the previous scene"}`} />
          ) : (
            <EmptyFrame
              label={inheritState === "needs-render"
                ? "Generate that scene first, then its last frame lands here."
                : inheritState === "capturing"
                  ? "Reading the last frame of that scene…"
                  : "No frame captured from that scene yet."}
            />
          )}
        </div>
      )}

      {node.startImageSource === "upload" && (
        <div className="flex flex-col gap-2">
          {node.startImageUrl
            ? <FramePreview url={node.startImageUrl} alt="Uploaded opening frame" />
            : <EmptyFrame label="No image chosen yet." />}
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="secondary"
              className="flex-1"
              onClick={() => startInputRef.current?.click()}
              disabled={busy === "start"}
            >
              {busy === "start" ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
              Replace
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void clearFrame("start")} disabled={busy === "start"}>
              <XIcon data-icon="inline-start" />
              Remove
            </Button>
          </div>
        </div>
      )}

      <Field>
        <FieldLabel htmlFor="end-frame-source">Closing frame</FieldLabel>
        <Select
          value={node.endImageSource}
          onValueChange={(value) => {
            if (value === "upload") {
              endInputRef.current?.click();
              return;
            }
            if (node.endImageUrl) void clearFrame("end");
            else onEdit({ endImageSource: "none", endImageUrl: undefined });
          }}
        >
          <SelectTrigger id="end-frame-source" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="none">Let the shot end where it wants</SelectItem>
              <SelectItem value="upload">Land on an image I upload…</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          Useful where several branches have to meet: land them all on the still the next
          scene opens on.
        </FieldDescription>
      </Field>

      {node.endImageSource === "upload" && (
        <div className="flex flex-col gap-2">
          {node.endImageUrl
            ? <FramePreview url={node.endImageUrl} alt="Uploaded closing frame" />
            : <EmptyFrame label="No image chosen yet." />}
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="secondary"
              className="flex-1"
              onClick={() => endInputRef.current?.click()}
              disabled={busy === "end"}
            >
              {busy === "end" ? <Spinner data-icon="inline-start" /> : <UploadIcon data-icon="inline-start" />}
              Replace
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void clearFrame("end")} disabled={busy === "end"}>
              <XIcon data-icon="inline-start" />
              Remove
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className={cn("text-xs", "text-destructive")} role="alert">{error}</p>
      )}
    </div>
  );
}
