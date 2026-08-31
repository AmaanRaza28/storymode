import { NextResponse } from "next/server";
import { z } from "zod";
import { processFalWebhook } from "@/lib/fal/process-webhook";
import { verifyFalWebhook } from "@/lib/fal/webhook-verification";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const webhookSchema = z.object({
  request_id: z.string().min(1),
  gateway_request_id: z.string().optional(),
  status: z.enum(["OK", "ERROR"]),
  payload: z
    .object({
      video: z.object({ url: z.url() }).passthrough().optional(),
    })
    .passthrough()
    .optional(),
  error: z.unknown().optional(),
});

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signatureValid = await verifyFalWebhook(request.headers, rawBody).catch(() => false);
  if (!signatureValid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  const parsed = webhookSchema.safeParse(JSON.parse(rawBody));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const webhookRequestId = request.headers.get("x-fal-webhook-request-id");
  if (!webhookRequestId || webhookRequestId !== parsed.data.request_id) {
    return NextResponse.json({ error: "Request ID mismatch" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase service credentials are required" }, { status: 500 });

  const result = await processFalWebhook(admin, parsed.data, webhookRequestId);
  return NextResponse.json({ ok: true, result }, { status: result === "parked" ? 202 : 200 });
}
