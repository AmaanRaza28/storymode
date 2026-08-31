"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  ArrowLeftIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  FilmIcon,
  GitBranchIcon,
  Maximize2Icon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { saveStoryAction } from "@/app/story-actions";
import { SceneContinuity } from "@/components/studio/scene-continuity";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { isPublishable } from "@/lib/story/engine";
import type {
  GameStatus,
  RenderJobUpdate,
  RenderResolution,
  RenderStatus,
  StoryChoice,
  StoryGame,
  StoryNode,
} from "@/lib/story/types";
import { cn } from "@/lib/utils";

type SceneNodeData = {
  title: string;
  eyebrow: string;
  status: RenderStatus;
  takeCount: number;
  isStart: boolean;
} & Record<string, unknown>;

type SceneFlowNode = Node<SceneNodeData, "scene">;

const statusLabel: Record<RenderStatus, string> = {
  draft: "Needs render",
  queued: "Queued",
  rendering: "Rendering",
  ready: "Ready",
  failed: "Failed",
};

function SceneNode({ data, selected }: NodeProps<SceneFlowNode>) {
  return (
    <div
      className={cn(
        "w-56 rounded-xl border bg-card p-3 shadow-md transition-shadow",
        selected && "ring-2 ring-ring shadow-xl",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-muted">
            <FilmIcon aria-hidden="true" />
          </span>
          <Badge variant={data.status === "ready" ? "secondary" : "outline"}>
            {(data.status === "queued" || data.status === "rendering") && (
              <Spinner data-icon="inline-start" />
            )}
            {statusLabel[data.status]}
          </Badge>
        </div>
        <div>
          <p className="text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase">
            {data.isStart ? "Opening scene" : data.eyebrow}
          </p>
          <p className="mt-1 text-sm font-semibold leading-tight">{data.title}</p>
          {data.takeCount > 1 && (
            <p className="mt-1 text-[0.7rem] text-muted-foreground">{data.takeCount} takes</p>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { scene: SceneNode };

/**
 * What a scene reads as to the author. Progress belongs to individual takes, not to the
 * scene, so a scene that already has a chosen video keeps reading as ready while an extra
 * take generates — and a scene whose last render was abandoned does not read as queued for
 * ever. The persisted status is only trusted before the takes have loaded.
 */
function sceneStatus(node: StoryNode, jobs: RenderJobUpdate[], jobsLoaded: boolean): RenderStatus {
  const active = jobs.filter((job) => job.status === "queued" || job.status === "rendering");
  if (active.length > 0) {
    return active.some((job) => job.status === "rendering") ? "rendering" : "queued";
  }
  if (node.videoUrl) return "ready";
  if (!jobsLoaded) return node.renderStatus;
  return node.renderStatus === "queued" || node.renderStatus === "rendering"
    ? "draft"
    : node.renderStatus;
}

/** Takes are cheap to list but not to generate, so the studio matches the server's cap. */
const MAX_ACTIVE_TAKES_PER_SCENE = 3;
/** fal rejects very short direction, so the button explains it rather than the error does. */
const MIN_PROMPT_LENGTH = 20;

/** Quiet period after the last edit before an autosave fires. */
const AUTOSAVE_DELAY_MS = 1200;
/** Failed autosaves back off, then stop until the next edit so a rejected graph cannot loop. */
const AUTOSAVE_RETRY_BASE_MS = 4000;
const AUTOSAVE_MAX_RETRIES = 3;

export function StoryStudio({ initialGame }: { initialGame: StoryGame }) {
  const [game, setGame] = useState(initialGame);
  const [selectedNodeId, selectNode] = useState(initialGame.startNodeId);
  // Every render attempt is kept, keyed by job, so re-generating adds a take instead of
  // replacing the one before it.
  const [renderJobs, setRenderJobs] = useState<Record<string, RenderJobUpdate>>({});
  const [jobsLoaded, setJobsLoaded] = useState(false);
  /** Which take the inline player is showing, per scene; defaults to the scene's own video. */
  const [viewingTakeByNode, setViewingTakeByNode] = useState<Record<string, string>>({});
  const [selectingTakeId, setSelectingTakeId] = useState<string | null>(null);
  const [playerMuted, setPlayerMuted] = useState(false);
  const [resolutionByNode, setResolutionByNode] = useState<Record<string, RenderResolution>>({});
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderNotice, setRenderNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("Loaded from Supabase");
  // Autosave tracks edits by revision: `revision` counts author edits, `syncedRevision`
  // is the newest revision persisted, and `failedRevision` parks a rejected attempt.
  const [revision, setRevision] = useState(0);
  const [syncedRevision, setSyncedRevision] = useState(0);
  const [failedRevision, setFailedRevision] = useState<number | null>(null);
  const gameRef = useRef(game);
  const revisionRef = useRef(revision);
  const retriesRef = useRef(0);
  const playerRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    gameRef.current = game;
    revisionRef.current = revision;
  }, [game, revision]);

  const dirty = revision !== syncedRevision;
  const autosaveFailed = failedRevision !== null && failedRevision === revision;

  /** Apply an author edit: marks the graph dirty so autosave picks it up. */
  const editGame = useCallback((update: (current: StoryGame) => StoryGame) => {
    setGame((current) => {
      const next = update(current);
      return next === current ? current : { ...next, updatedAt: "Unsaved changes" };
    });
    setRevision((current) => current + 1);
    setFailedRevision(null);
    retriesRef.current = 0;
  }, []);

  const persist = useCallback(
    async ({ status, revalidate = false }: { status?: GameStatus; revalidate?: boolean } = {}) => {
      const attempt = revisionRef.current;
      const target: StoryGame = { ...gameRef.current, status: status ?? gameRef.current.status };
      setSaving(true);
      const result = await saveStoryAction(target, { revalidate });
      setSaving(false);

      if (result.status === "success") {
        retriesRef.current = 0;
        setFailedRevision(null);
        setSyncedRevision(attempt);
        setSaveMessage("All changes saved");
        // Merge rather than replace: edits made while the request was in flight must survive.
        setGame((current) => ({ ...current, status: target.status, updatedAt: "Just now" }));
      } else {
        retriesRef.current += 1;
        setFailedRevision(attempt);
        setSaveMessage(result.message ?? "Save failed");
      }
      return result;
    },
    [],
  );

  useEffect(() => {
    if (saving || !dirty) return;
    const retrying = failedRevision === revision;
    if (retrying && retriesRef.current >= AUTOSAVE_MAX_RETRIES) return;
    const delay = retrying
      ? Math.min(30_000, AUTOSAVE_RETRY_BASE_MS * 2 ** (retriesRef.current - 1))
      : AUTOSAVE_DELAY_MS;
    const timer = window.setTimeout(() => void persist(), delay);
    return () => window.clearTimeout(timer);
  }, [dirty, failedRevision, persist, revision, saving]);

  // Leaving with pending work: flush when the tab is backgrounded, warn on a hard unload.
  useEffect(() => {
    if (!dirty || saving) return;
    function flush() {
      if (document.visibilityState === "hidden") void persist();
    }
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [dirty, persist, saving]);

  useEffect(() => {
    if (!dirty && !saving) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);

  const updateNode = useCallback((nodeId: string, updates: Partial<StoryNode>) => {
    editGame((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, ...updates } : node),
    }));
  }, [editGame]);

  /** Render status is owned by the server, so mirroring it locally must not mark the graph dirty. */
  const applyRenderStatus = useCallback((nodeId: string, updates: Partial<StoryNode>) => {
    setGame((current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, ...updates } : node),
    }));
  }, []);

  const updateChoice = useCallback((choiceId: string, updates: Partial<StoryChoice>) => {
    editGame((current) => ({
      ...current,
      choices: current.choices.map((choice) => choice.id === choiceId ? { ...choice, ...updates } : choice),
    }));
  }, [editGame]);

  const addScene = useCallback(() => {
    const id = crypto.randomUUID();
    editGame((current) => {
      const maxX = Math.max(...current.nodes.map((node) => node.position.x));
      return {
        ...current,
        nodes: [...current.nodes, {
          id,
          title: "Untitled scene",
          eyebrow: `Chapter ${String(current.nodes.length + 1).padStart(2, "0")}`,
          narrative: "Describe what happens at this point in the story.",
          videoPrompt: "Describe the shot, action, camera, lighting, and sound.",
          tone: "signal",
          durationSeconds: 5,
          renderStatus: "draft",
          startImageSource: "none",
          endImageSource: "none",
          position: { x: maxX + 340, y: 420 },
        }],
      };
    });
    selectNode(id);
  }, [editGame]);

  const connectScenes = useCallback((fromNodeId: string, toNodeId: string) => {
    editGame((current) => {
      const duplicate = current.choices.some((choice) => choice.fromNodeId === fromNodeId && choice.toNodeId === toNodeId);
      if (duplicate || fromNodeId === toNodeId) return current;
      const branchNumber = current.choices.filter((choice) => choice.fromNodeId === fromNodeId).length + 1;
      return {
        ...current,
        choices: [...current.choices, {
          id: crypto.randomUUID(),
          fromNodeId,
          toNodeId,
          label: `Option ${branchNumber}`,
          hint: "Describe what this choice means for the player.",
        }],
      };
    });
  }, [editGame]);

  // Oldest take first, so take numbers stay put as new ones arrive.
  const jobsByNode = useMemo(() => {
    const grouped = new Map<string, RenderJobUpdate[]>();
    for (const job of Object.values(renderJobs)) {
      const existing = grouped.get(job.nodeId);
      if (existing) existing.push(job);
      else grouped.set(job.nodeId, [job]);
    }
    for (const jobs of grouped.values()) {
      jobs.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    }
    return grouped;
  }, [renderJobs]);

  const selectedNode = game.nodes.find((node) => node.id === selectedNodeId) ?? game.nodes[0];
  const selectedResolution = resolutionByNode[selectedNode.id] ?? "480P";
  const sceneJobs = jobsByNode.get(selectedNode.id) ?? [];
  const takeNumbers = new Map(sceneJobs.map((job, index) => [job.jobId, index + 1]));
  const activeTakes = sceneJobs.filter((job) => job.status === "queued" || job.status === "rendering");
  const readyTakes = sceneJobs.filter((job) => job.status === "ready" && job.videoUrl);
  // The scene's own video is the chosen take; the player can preview any other one first.
  const sceneTake = readyTakes.find((take) => take.videoUrl === selectedNode.videoUrl);
  const viewingTake = readyTakes.find((take) => take.jobId === viewingTakeByNode[selectedNode.id])
    ?? sceneTake
    // Nothing chosen yet: offer the newest take. A scene that has a video keeps showing it
    // even when the take behind it is no longer in the loaded history.
    ?? (selectedNode.videoUrl ? undefined : readyTakes.at(-1));
  const previewUrl = viewingTake?.videoUrl ?? selectedNode.videoUrl;
  const previewIsSceneVideo = Boolean(previewUrl) && previewUrl === selectedNode.videoUrl;
  const sceneDisplayStatus = sceneStatus(selectedNode, sceneJobs, jobsLoaded);
  const promptTooShort = selectedNode.videoPrompt.trim().length < MIN_PROMPT_LENGTH;
  const atTakeLimit = activeTakes.length >= MAX_ACTIVE_TAKES_PER_SCENE;
  const outgoingChoices = game.choices.filter((choice) => choice.fromNodeId === selectedNode.id);
  const readyCount = game.nodes.filter((node) => node.videoUrl).length;
  const saveStatusText = saving
    ? "Saving…"
    : autosaveFailed
      ? `Autosave failed: ${saveMessage}`
      : dirty
        ? "Unsaved changes · autosaving"
        : saveMessage;

  const applyRenderJob = useCallback((job: RenderJobUpdate) => {
    setRenderJobs((current) => ({ ...current, [job.jobId]: job }));
    setResolutionByNode((current) => current[job.nodeId]
      ? current
      : { ...current, [job.nodeId]: job.resolution });

    if (job.status === "ready" && job.videoUrl) {
      const videoUrl = job.videoUrl;
      // The take that just finished becomes the scene's video and what the player shows,
      // so the author watches what they generated. Earlier takes stay selectable.
      applyRenderStatus(job.nodeId, { renderStatus: "ready", videoUrl });
      setViewingTakeByNode((current) => ({ ...current, [job.nodeId]: job.jobId }));
      setRenderNotice("New take ready — it now plays in this scene");
      return;
    }
    if (job.status === "failed") {
      setRenderError(job.message ?? "Render failed");
      // A failed extra take must not cost the scene a video it already has.
      setGame((current) => ({
        ...current,
        nodes: current.nodes.map((node) => node.id === job.nodeId && !node.videoUrl
          ? { ...node, renderStatus: "failed" }
          : node),
      }));
    }
  }, [applyRenderStatus]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/renders?gameId=${encodeURIComponent(game.id)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load render jobs");
        return response.json() as Promise<{ jobs: RenderJobUpdate[] }>;
      })
      .then(({ jobs }) => {
        if (cancelled) return;
        // Seeded rather than applied one by one: these takes are already reflected in the
        // scenes loaded from the database, so replaying them must not re-pick a video.
        setRenderJobs((current) => ({
          ...Object.fromEntries(jobs.map((job) => [job.jobId, job])),
          ...current,
        }));
        setResolutionByNode((current) => {
          const next = { ...current };
          // Newest first from the API, so a scene's newest take seeds its resolution.
          for (const job of jobs) next[job.nodeId] ??= job.resolution;
          return next;
        });
        setJobsLoaded(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setRenderError(error instanceof Error ? error.message : "Unable to load render jobs");
      });
    return () => { cancelled = true; };
  }, [game.id]);

  const activeJobIds = Object.values(renderJobs)
    .filter((job) => job.status === "queued" || job.status === "rendering")
    .map((job) => job.jobId)
    .sort()
    .join(",");

  useEffect(() => {
    if (!activeJobIds) return;
    let cancelled = false;

    async function poll() {
      const jobIds = activeJobIds.split(",");
      await Promise.all(jobIds.map(async (jobId) => {
        try {
          const response = await fetch(`/api/renders?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" });
          const body = await response.json() as { job?: RenderJobUpdate; error?: string };
          if (!response.ok || !body.job) throw new Error(body.error ?? "Unable to check render status");
          if (!cancelled) {
            setRenderError(null);
            applyRenderJob(body.job);
          }
        } catch (error) {
          if (!cancelled) setRenderError(error instanceof Error ? error.message : "Unable to check render status");
        }
      }));
    }

    void poll();
    const interval = window.setInterval(() => void poll(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeJobIds, applyRenderJob]);

  // Takes carry native audio, so the inline player tries sound first and drops to muted
  // only when the browser refuses unmuted autoplay. React does not reliably apply `muted`
  // on hydration, so it is set on the element itself.
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !previewUrl) return;
    player.muted = playerMuted;
    player.volume = 1;
    player.play().catch(() => {
      if (!playerMuted) setPlayerMuted(true);
    });
  }, [playerMuted, previewUrl]);

  const storyNodes = useMemo<SceneFlowNode[]>(
    () =>
      game.nodes.map((node) => {
        const jobs = jobsByNode.get(node.id) ?? [];
        return {
          id: node.id,
          type: "scene",
          position: node.position,
          selected: node.id === selectedNodeId,
          data: {
            title: node.title,
            eyebrow: node.eyebrow,
            status: sceneStatus(node, jobs, jobsLoaded),
            takeCount: jobs.filter((job) => job.status === "ready" && job.videoUrl).length,
            isStart: node.id === game.startNodeId,
          },
        };
      }),
    [game.nodes, game.startNodeId, jobsByNode, jobsLoaded, selectedNodeId],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(storyNodes);

  useEffect(() => {
    setNodes(storyNodes);
  }, [setNodes, storyNodes]);

  const edges = useMemo<Edge[]>(
    () =>
      game.choices.map((choice) => ({
        id: choice.id,
        source: choice.fromNodeId,
        target: choice.toNodeId,
        label: choice.label,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { strokeWidth: 1.5 },
      })),
    [game.choices],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        connectScenes(connection.source, connection.target);
      }
    },
    [connectScenes],
  );

  function deleteSelectedScene() {
    if (game.nodes.length <= 1) return;

    const deletedNodeId = selectedNode.id;
    const deletedNodeIndex = game.nodes.findIndex((node) => node.id === deletedNodeId);
    const remainingNodes = game.nodes.filter((node) => node.id !== deletedNodeId);
    const nextSelectedNode = remainingNodes[Math.min(deletedNodeIndex, remainingNodes.length - 1)];

    editGame((current) => ({
      ...current,
      startNodeId: current.startNodeId === deletedNodeId ? nextSelectedNode.id : current.startNodeId,
      nodes: current.nodes
        .filter((node) => node.id !== deletedNodeId)
        // A scene continuing from the deleted one has nothing left to continue from. The
        // column's foreign key clears this server-side too; doing it here keeps the
        // inspector from showing a source that is already gone.
        .map((node) => node.startImageFromNodeId === deletedNodeId
          ? { ...node, startImageSource: "none" as const, startImageFromNodeId: undefined }
          : node),
      choices: current.choices.filter(
        (choice) => choice.fromNodeId !== deletedNodeId && choice.toNodeId !== deletedNodeId,
      ),
    }));
    selectNode(nextSelectedNode.id);
  }

  async function renderSelectedScene() {
    setRenderError(null);
    setRenderNotice(null);
    // Which stills this scene opens and closes on are read from the database by the
    // render route, not taken from the request, so an unsaved change to them would be
    // silently ignored. Flush first and let a failed save stop the render.
    if (dirty) {
      const saved = await persist();
      if (saved.status !== "success") {
        setRenderError(saved.message ?? "Save your changes before generating this scene");
        return;
      }
    }
    // A scene that already has a video keeps it, and its status, while an extra take
    // renders; the render route applies the same rule to the stored scene.
    if (!selectedNode.videoUrl) applyRenderStatus(selectedNode.id, { renderStatus: "queued" });
    try {
      const response = await fetch("/api/renders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gameId: game.id,
          nodeId: selectedNode.id,
          prompt: selectedNode.videoPrompt,
          duration: selectedNode.durationSeconds,
          resolution: selectedResolution,
        }),
      });
      const body = await response.json() as { job?: RenderJobUpdate; error?: string };
      if (!response.ok || !body.job) throw new Error(body.error ?? "Render request failed");
      applyRenderJob(body.job);
      setRenderNotice(
        `Take ${sceneJobs.length + 1} queued at ${selectedResolution.toLowerCase()}`,
      );
    } catch (error) {
      if (!selectedNode.videoUrl) applyRenderStatus(selectedNode.id, { renderStatus: "failed" });
      setRenderError(error instanceof Error ? error.message : "Render request failed");
    }
  }

  /** Point the scene at one of its takes. The route persists it, so this is not an edit. */
  async function applyTakeToScene(take: RenderJobUpdate) {
    if (!take.videoUrl) return;
    setRenderError(null);
    setRenderNotice(null);
    setSelectingTakeId(take.jobId);
    try {
      const response = await fetch("/api/renders", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gameId: game.id, nodeId: take.nodeId, jobId: take.jobId }),
      });
      const body = await response.json() as { videoUrl?: string; error?: string };
      if (!response.ok || !body.videoUrl) throw new Error(body.error ?? "Unable to use that take");
      applyRenderStatus(take.nodeId, { renderStatus: "ready", videoUrl: body.videoUrl });
      setRenderNotice(`Take ${takeNumbers.get(take.jobId)} now plays in this scene`);
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : "Unable to use that take");
    } finally {
      setSelectingTakeId(null);
    }
  }

  function discardEdits() {
    // Autosave may already have persisted intermediate edits, so the revert is itself
    // an edit that has to be written back.
    editGame(() => initialGame);
    selectNode(initialGame.startNodeId);
  }

  async function togglePublish() {
    if (game.status === "draft" && !isPublishable(game)) return;
    await persist({ status: game.status === "published" ? "draft" : "published", revalidate: true });
  }

  return (
    <div className="flex min-h-screen flex-col bg-muted/35">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className={buttonVariants({ variant: "ghost", size: "icon-sm" })} aria-label="Back to dashboard">
            <ArrowLeftIcon />
          </Link>
          <Separator orientation="vertical" className="h-7" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold">{game.title}</h1>
              <Badge variant="outline">{game.status}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {readyCount}/{game.nodes.length} scenes ready ·{" "}
              <span className={cn(autosaveFailed && "text-destructive")} role="status" aria-live="polite">
                {saveStatusText}
              </span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={discardEdits} disabled={saving}>
            <RotateCcwIcon data-icon="inline-start" />
            Discard edits
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void persist({ revalidate: true })}
            disabled={saving || (!dirty && !autosaveFailed)}
          >
            {saving ? (
              <Spinner data-icon="inline-start" />
            ) : autosaveFailed ? (
              <CircleAlertIcon data-icon="inline-start" />
            ) : (
              <SaveIcon data-icon="inline-start" />
            )}
            {saving ? "Saving" : autosaveFailed ? "Retry save" : dirty ? "Save now" : "Saved"}
          </Button>
          <Link href={`/play/${game.slug}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <PlayIcon data-icon="inline-start" />
            Preview
          </Link>
          <Button size="sm" onClick={togglePublish} disabled={saving || (game.status === "draft" && !isPublishable(game))}>
            <CheckIcon data-icon="inline-start" />
            {game.status === "published" ? "Published" : "Publish"}
          </Button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="relative min-h-[58vh] border-b lg:min-h-0 lg:border-r lg:border-b-0" aria-label="Story graph">
          <div className="absolute top-4 left-4 z-10 flex gap-2">
            <Button size="sm" onClick={addScene}>
              <PlusIcon data-icon="inline-start" />
              Add scene
            </Button>
            <Badge variant="secondary">
              <GitBranchIcon data-icon="inline-start" />
              Drag between handles to branch
            </Badge>
          </div>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onConnect={onConnect}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => selectNode(node.id)}
            onNodeDragStop={(_, node) => updateNode(node.id, { position: node.position })}
            fitView
            fitViewOptions={{ padding: 0.24 }}
            minZoom={0.35}
            maxZoom={1.4}
          >
            <Background gap={24} size={1} />
            <Controls position="bottom-left" />
          </ReactFlow>
        </section>

        <aside className="flex min-h-0 flex-col bg-background">
          <div className="border-b p-5">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Scene inspector</p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">{selectedNode.title}</h2>
          </div>
          <Tabs defaultValue="story" className="min-h-0 flex-1 overflow-y-auto p-5">
            <TabsList className="w-full">
              <TabsTrigger value="story">Story</TabsTrigger>
              <TabsTrigger value="direction">Direction</TabsTrigger>
            </TabsList>
            <TabsContent value="story" className="pt-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="scene-title">Scene title</FieldLabel>
                  <Input
                    id="scene-title"
                    value={selectedNode.title}
                    onChange={(event) => updateNode(selectedNode.id, { title: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="scene-copy">What happens</FieldLabel>
                  <Textarea
                    id="scene-copy"
                    rows={7}
                    value={selectedNode.narrative}
                    onChange={(event) => updateNode(selectedNode.id, { narrative: event.target.value })}
                  />
                  <FieldDescription>This copy appears during playback and anchors the generated shot.</FieldDescription>
                </Field>
                <FieldSet>
                  <FieldLegend variant="label">Player options from this scene</FieldLegend>
                  <FieldDescription>
                    Drag from this scene to another scene, then name the choice the player will see.
                  </FieldDescription>
                  {outgoingChoices.length > 0 ? (
                    <FieldGroup>
                      {outgoingChoices.map((choice, index) => {
                        const target = game.nodes.find((node) => node.id === choice.toNodeId);
                        return (
                          <Field key={choice.id}>
                            <FieldLabel htmlFor={`choice-${choice.id}`}>Option {index + 1}</FieldLabel>
                            <Input
                              id={`choice-${choice.id}`}
                              value={choice.label}
                              onChange={(event) => updateChoice(choice.id, { label: event.target.value })}
                            />
                            <Input
                              aria-label={`Option ${index + 1} hint`}
                              value={choice.hint}
                              placeholder="Optional supporting hint"
                              onChange={(event) => updateChoice(choice.id, { hint: event.target.value })}
                            />
                            <FieldDescription>Leads to {target?.title ?? "another scene"}.</FieldDescription>
                          </Field>
                        );
                      })}
                    </FieldGroup>
                  ) : (
                    <FieldDescription>No options yet. Create a branch on the canvas to add one.</FieldDescription>
                  )}
                </FieldSet>
              </FieldGroup>
            </TabsContent>
            <TabsContent value="direction" className="pt-4">
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="video-prompt">Video direction</FieldLabel>
                  <Textarea
                    id="video-prompt"
                    rows={10}
                    value={selectedNode.videoPrompt}
                    onChange={(event) => updateNode(selectedNode.id, { videoPrompt: event.target.value })}
                  />
                  <FieldDescription>Describe the action, camera, continuity, lighting, dialogue, and sound.</FieldDescription>
                </Field>
                <FieldSet>
                  <FieldLegend variant="label">Continuity</FieldLegend>
                  <FieldDescription>
                    Scenes are generated independently unless you chain them. Opening on the
                    previous scene&rsquo;s last frame is what keeps a cut from re-rolling the shot.
                  </FieldDescription>
                  <SceneContinuity
                    game={game}
                    node={selectedNode}
                    onEdit={(updates) => updateNode(selectedNode.id, updates)}
                    onSync={applyRenderStatus}
                  />
                </FieldSet>
              </FieldGroup>
            </TabsContent>
          </Tabs>
          <div className="border-t p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">H3 Max · {selectedResolution.toLowerCase()}</p>
                <p className="text-xs text-muted-foreground">{selectedNode.durationSeconds}s with native audio</p>
              </div>
              <Badge variant={sceneDisplayStatus === "ready" ? "secondary" : "outline"}>
                {statusLabel[sceneDisplayStatus]}
              </Badge>
            </div>
            {/* Generated video plays here, so watching it costs no save-then-preview trip. */}
            <div className="mb-3">
              {previewUrl ? (
                <div className="relative overflow-hidden rounded-xl border bg-black">
                  <video
                    key={previewUrl}
                    ref={playerRef}
                    className="aspect-video w-full"
                    src={previewUrl}
                    controls
                    loop
                    playsInline
                    preload="metadata"
                  />
                  <div className="pointer-events-none absolute top-2 left-2 flex flex-wrap gap-1.5">
                    <Badge variant="secondary">
                      {viewingTake
                        ? `Take ${takeNumbers.get(viewingTake.jobId)} · ${viewingTake.resolution.toLowerCase()}`
                        : "Scene video"}
                    </Badge>
                    {previewIsSceneVideo && (
                      <Badge variant="secondary">
                        <CircleCheckIcon data-icon="inline-start" />
                        In this scene
                      </Badge>
                    )}
                  </div>
                  <Dialog>
                    <DialogTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="secondary"
                          className="absolute top-2 right-2"
                          aria-label="Open this take full size"
                        />
                      }
                    >
                      <Maximize2Icon />
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>{selectedNode.title || "Untitled scene"}</DialogTitle>
                        <DialogDescription>
                          {viewingTake
                            ? `Take ${takeNumbers.get(viewingTake.jobId)} · ${viewingTake.resolution.toLowerCase()} · ${viewingTake.durationSeconds}s`
                            : "Current scene video"}
                        </DialogDescription>
                      </DialogHeader>
                      <video
                        className="aspect-video w-full rounded-lg bg-black"
                        src={previewUrl}
                        controls
                        autoPlay
                        playsInline
                      />
                      {viewingTake?.prompt && (
                        <div>
                          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                            Direction this take was generated from
                          </p>
                          <p className="mt-1 max-h-32 overflow-y-auto text-xs leading-relaxed text-muted-foreground">
                            {viewingTake.prompt}
                          </p>
                        </div>
                      )}
                    </DialogContent>
                  </Dialog>
                </div>
              ) : (
                <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 px-4 text-center">
                  {activeTakes.length > 0 ? (
                    <Spinner />
                  ) : (
                    <FilmIcon aria-hidden="true" className="text-muted-foreground" />
                  )}
                  <p className="text-xs text-muted-foreground">
                    {activeTakes.length > 0
                      ? "Your first take is generating. It plays here as soon as it lands."
                      : "Generate this scene to watch it here."}
                  </p>
                </div>
              )}
            </div>
            {sceneJobs.length > 0 && (
              <div className="mb-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Takes · {readyTakes.length}
                  </p>
                  {viewingTake && !previewIsSceneVideo && (
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => void applyTakeToScene(viewingTake)}
                      disabled={selectingTakeId !== null}
                    >
                      {selectingTakeId === viewingTake.jobId ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <CircleCheckIcon data-icon="inline-start" />
                      )}
                      Use this take
                    </Button>
                  )}
                </div>
                {/* Newest take first, so a fresh one needs no scrolling to reach. */}
                <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                  {[...sceneJobs].reverse().map((take) => {
                    const number = takeNumbers.get(take.jobId);
                    const pending = take.status === "queued" || take.status === "rendering";
                    const inScene = Boolean(take.videoUrl) && take.videoUrl === selectedNode.videoUrl;
                    const isViewing = take.jobId === viewingTake?.jobId;
                    return (
                      <button
                        key={take.jobId}
                        type="button"
                        onClick={() => setViewingTakeByNode((current) => ({
                          ...current,
                          [selectedNode.id]: take.jobId,
                        }))}
                        disabled={!take.videoUrl}
                        aria-pressed={isViewing}
                        aria-label={`Take ${number}, ${statusLabel[take.status].toLowerCase()}${inScene ? ", used in this scene" : ""}`}
                        title={`Take ${number} · ${take.resolution.toLowerCase()} · ${take.durationSeconds}s · ${statusLabel[take.status]}`}
                        className={cn(
                          "relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg border bg-muted",
                          take.videoUrl ? "hover:opacity-90" : "cursor-default",
                          isViewing && "ring-2 ring-ring",
                        )}
                      >
                        {take.videoUrl ? (
                          <video
                            className="absolute inset-0 size-full object-cover"
                            src={`${take.videoUrl}#t=0.1`}
                            muted
                            playsInline
                            preload="metadata"
                          />
                        ) : (
                          <span className="absolute inset-0 flex items-center justify-center">
                            {pending ? (
                              <Spinner />
                            ) : (
                              <CircleAlertIcon aria-hidden="true" className="size-4 text-destructive" />
                            )}
                          </span>
                        )}
                        <span className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/75 to-transparent px-1.5 pt-3 pb-1 text-[0.65rem] font-medium text-white">
                          <span>Take {number}</span>
                          {inScene && <CircleCheckIcon aria-hidden="true" className="size-3" />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Field>
                <FieldLabel htmlFor="render-resolution">Render resolution</FieldLabel>
                <Select
                  value={selectedResolution}
                  onValueChange={(value) => setResolutionByNode((current) => ({
                    ...current,
                    [selectedNode.id]: value as RenderResolution,
                  }))}
                >
                  <SelectTrigger id="render-resolution" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="480P">480p · faster and lower cost</SelectItem>
                      <SelectItem value="768P">768p · higher quality</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              {activeTakes.map((take) => (
                <div
                  key={take.jobId}
                  className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3"
                  role="status"
                  aria-live="polite"
                >
                  <Spinner data-icon="inline-start" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      Take {takeNumbers.get(take.jobId)} · {statusLabel[take.status]}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {take.message ?? "Checking fal.ai for updates…"}
                    </p>
                    {take.logs.at(-1) && (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{take.logs.at(-1)}</p>
                    )}
                  </div>
                </div>
              ))}
              {renderError ? (
                <div className="flex items-start gap-2 text-sm text-destructive" role="alert">
                  <CircleAlertIcon aria-hidden="true" />
                  <p>{renderError}</p>
                </div>
              ) : renderNotice ? (
                <p className="text-xs text-muted-foreground" role="status" aria-live="polite">{renderNotice}</p>
              ) : null}
              <Button
                className="w-full"
                onClick={renderSelectedScene}
                disabled={atTakeLimit || promptTooShort}
              >
                {atTakeLimit ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <SparklesIcon data-icon="inline-start" />
                )}
                {atTakeLimit
                  ? "Waiting on takes in progress"
                  : sceneJobs.length > 0
                    ? "Generate another take"
                    : "Generate scene"}
              </Button>
              {promptTooShort && (
                <p className="text-center text-xs text-muted-foreground">
                  Write at least {MIN_PROMPT_LENGTH} characters of video direction first.
                </p>
              )}
              <Dialog>
                <DialogTrigger
                  render={
                    <Button
                      className="w-full"
                      variant="destructive"
                      disabled={game.nodes.length <= 1}
                    />
                  }
                >
                  <Trash2Icon data-icon="inline-start" />
                  Delete scene
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete “{selectedNode.title || "Untitled scene"}”?</DialogTitle>
                    <DialogDescription>
                      This removes the scene and every branch connected to it. If this is the opening
                      scene, the nearest remaining scene will become the new opening.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
                    <DialogClose render={<Button variant="destructive" onClick={deleteSelectedScene} />}>
                      <Trash2Icon data-icon="inline-start" />
                      Delete scene
                    </DialogClose>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              {game.nodes.length <= 1 && (
                <p className="text-center text-xs text-muted-foreground">A story needs at least one scene.</p>
              )}
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
