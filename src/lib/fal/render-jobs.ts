import { fal } from "@fal-ai/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processFalWebhook, type FalWebhookPayload } from "@/lib/fal/process-webhook";
import type { RenderJobUpdate, RenderResolution, RenderStatus } from "@/lib/story/types";

export type RenderEndpoint =
  | "minimax/h3-max/text-to-video"
  | "minimax/h3-max/image-to-video";

export interface RenderJobRow {
  id: string;
  node_id: string;
  requested_by: string | null;
  model: string;
  provider_request_id: string | null;
  status: RenderStatus;
  input: unknown;
  output: unknown;
  error: unknown;
  created_at: string;
  completed_at: string | null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function renderResolution(input: unknown): RenderResolution {
  return objectValue(input).resolution === "768P" ? "768P" : "480P";
}

function renderPrompt(input: unknown) {
  const prompt = objectValue(input).prompt;
  return typeof prompt === "string" ? prompt : "";
}

function renderDuration(input: unknown) {
  const duration = objectValue(input).duration;
  return typeof duration === "number" ? duration : 5;
}

function outputVideoUrl(output: unknown) {
  const video = objectValue(objectValue(output).video);
  return typeof video.url === "string" ? video.url : undefined;
}

function errorMessage(error: unknown) {
  const message = objectValue(error).message;
  return typeof message === "string" ? message : undefined;
}

export function serializeRenderJob(
  job: RenderJobRow,
  extras: Partial<Pick<RenderJobUpdate, "queuePosition" | "logs" | "message">> = {},
): RenderJobUpdate {
  const videoUrl = outputVideoUrl(job.output);
  const message = extras.message ?? errorMessage(job.error);

  return {
    jobId: job.id,
    nodeId: job.node_id,
    status: job.status,
    resolution: renderResolution(job.input),
    prompt: renderPrompt(job.input),
    durationSeconds: renderDuration(job.input),
    createdAt: job.created_at,
    ...(job.completed_at ? { completedAt: job.completed_at } : {}),
    ...(typeof extras.queuePosition === "number" ? { queuePosition: extras.queuePosition } : {}),
    logs: extras.logs ?? [],
    ...(message ? { message } : {}),
    ...(videoUrl ? { videoUrl } : {}),
  };
}

async function readJob(admin: SupabaseClient, jobId: string) {
  const { data } = await admin
    .from("render_jobs")
    .select("id,node_id,requested_by,model,provider_request_id,status,input,output,error,created_at,completed_at")
    .eq("id", jobId)
    .single();
  return data as RenderJobRow | null;
}

export async function reconcileRenderJob(admin: SupabaseClient, job: RenderJobRow) {
  if (job.status === "ready" || job.status === "failed" || !job.provider_request_id) {
    return serializeRenderJob(job);
  }

  const endpoint = job.model as RenderEndpoint;
  const queueStatus = await fal.queue.status(endpoint, {
    requestId: job.provider_request_id,
    logs: true,
  });
  const logs = "logs" in queueStatus
    ? queueStatus.logs.slice(-5).map((entry) => entry.message)
    : [];

  if (queueStatus.status === "IN_QUEUE") {
    return serializeRenderJob(job, {
      queuePosition: queueStatus.queue_position,
      logs,
      message: queueStatus.queue_position > 0
        ? `Waiting in queue · position ${queueStatus.queue_position}`
        : "Waiting for a render worker",
    });
  }

  if (queueStatus.status === "IN_PROGRESS") {
    if (job.status !== "rendering") {
      await Promise.all([
        admin.from("render_jobs").update({ status: "rendering" }).eq("id", job.id),
        // A scene that already has a chosen take stays 'ready': this attempt is an extra
        // take, and its progress is reported from the job rather than the scene.
        admin
          .from("story_nodes")
          .update({ render_status: "rendering" })
          .eq("id", job.node_id)
          .is("video_url", null),
      ]);
    }
    return serializeRenderJob({ ...job, status: "rendering" }, {
      logs,
      message: logs.at(-1) ?? "Generating video and native audio",
    });
  }

  try {
    const result = await fal.queue.result(endpoint, { requestId: job.provider_request_id });
    const payload = result.data as FalWebhookPayload["payload"];
    if (!payload?.video?.url) throw new Error("fal completed without returning a video");

    await processFalWebhook(admin, {
      request_id: job.provider_request_id,
      status: "OK",
      payload,
    }, `poll:${job.provider_request_id}`);
  } catch (error) {
    const completedAt = new Date().toISOString();
    const failure = { message: error instanceof Error ? error.message : "Unable to retrieve fal result" };
    await Promise.all([
      admin.from("render_jobs").update({ status: "failed", error: failure, completed_at: completedAt }).eq("id", job.id),
      admin
        .from("story_nodes")
        .update({ render_status: "failed", updated_at: completedAt })
        .eq("id", job.node_id)
        .is("video_url", null),
    ]);
  }

  const updatedJob = await readJob(admin, job.id);
  return serializeRenderJob(updatedJob ?? job, { logs });
}
