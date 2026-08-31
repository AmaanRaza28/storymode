import { createHash, createPublicKey, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

interface JwkKey extends JsonWebKey {
  x: string;
}

let cachedKeys: JwkKey[] | null = null;
let cachedAt = 0;
const JWKS_URL = "https://rest.fal.ai/.well-known/jwks.json";
const CACHE_MS = 24 * 60 * 60 * 1000;

async function getJwks() {
  if (cachedKeys && Date.now() - cachedAt < CACHE_MS) return cachedKeys;
  const response = await fetch(JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Unable to fetch fal JWKS: ${response.status}`);
  const result = (await response.json()) as { keys?: JwkKey[] };
  cachedKeys = result.keys ?? [];
  cachedAt = Date.now();
  return cachedKeys;
}

export async function verifyFalWebhook(headers: Headers, rawBody: string) {
  if (process.env.FAL_WEBHOOK_SKIP_VERIFY === "true" && process.env.NODE_ENV !== "production") {
    return true;
  }

  const requestId = headers.get("x-fal-webhook-request-id");
  const userId = headers.get("x-fal-webhook-user-id");
  const timestamp = headers.get("x-fal-webhook-timestamp");
  const signatureHex = headers.get("x-fal-webhook-signature");
  if (!requestId || !userId || !timestamp || !signatureHex) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > 300) return false;

  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const message = Buffer.from(`${requestId}\n${userId}\n${timestamp}\n${bodyHash}`, "utf8");
  const signature = Buffer.from(signatureHex, "hex");
  const keys = await getJwks();

  return keys.some((jwk) => {
    try {
      const publicKey = createPublicKey({ key: jwk, format: "jwk" });
      return verify(null, message, publicKey, signature);
    } catch {
      return false;
    }
  });
}
