import type { SupabaseClient } from "@supabase/supabase-js";

export interface FalWebhookPayload {
  request_id: string;
  gateway_request_id?: string;
  status: "OK" | "ERROR";
  payload?: {
    video?: { url: string };
    [key: string]: unknown;
  };
  error?: unknown;
}

export async function processFalWebhook(
  admin: SupabaseClient,
  payload: FalWebhookPayload,
  webhookRequestId: string,
) {
  const receivedAt = new Date().toISOString();
  await admin.from("webhook_events").upsert(
    {
      provider_request_id: payload.request_id,
      webhook_request_id: webhookRequestId,
      payload,
      received_at: receivedAt,
    },
    { onConflict: "provider_request_id" },
  );

  const { data: job } = await admin
    .from("render_jobs")
    .select("id,node_id")
    .eq("provider_request_id", payload.request_id)
    .maybeSingle();

  if (!job) return "parked" as const;

  const ready = payload.status === "OK" && Boolean(payload.payload?.video?.url);
  const { data: updatedJob } = await admin
    .from("render_jobs")
    .update({
      status: ready ? "ready" : "failed",
      output: payload.payload ?? null,
      error: ready ? null : payload.error ?? { message: "fal render failed" },
      completed_at: receivedAt,
    })
    .eq("id", job.id)
    .in("status", ["queued", "rendering"])
    .select("id")
    .maybeSingle();

  if (!updatedJob) return "duplicate" as const;

  // A finished take becomes the scene's video, so the author sees what they just
  // generated without having to pick it. Earlier takes stay in render_jobs, selectable.
  if (ready) {
    await admin
      .from("story_nodes")
      .update({
        render_status: "ready",
        video_url: payload.payload?.video?.url,
        updated_at: receivedAt,
      })
      .eq("id", job.node_id);
  } else {
    // A failed extra take must not strip a scene of a video it already has.
    await admin
      .from("story_nodes")
      .update({ render_status: "failed", updated_at: receivedAt })
      .eq("id", job.node_id)
      .is("video_url", null);
  }

  await admin
    .from("webhook_events")
    .update({ processed_at: receivedAt })
    .eq("provider_request_id", payload.request_id);

  return "processed" as const;
}
