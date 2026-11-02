import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookChallenge, verifyWebhookSignature } from "@/modules/channels/facebook/normalizer";
import { ingestMetaWebhook } from "@/modules/channels/facebook/webhook";
import { childLogger } from "@/core/logger";
import { getEnv } from "@/core/env";
import { prisma } from "@/core/db/prisma";

const log = childLogger("webhooks.meta");

export const runtime = "nodejs";

/** Meta webhook subscription verification (GET). */
export async function GET(req: NextRequest) {
  const result = verifyWebhookChallenge(req.nextUrl.searchParams);
  if (!result.ok) {
    log.warn("webhook_verification_failed");
    return NextResponse.json({ error: "VERIFICATION_FAILED" }, { status: 403 });
  }
  return new NextResponse(result.challenge, { status: 200 });
}

/**
 * POST — Meta webhook receiver.
 * verify signature → persist raw (idempotent) → route page → enqueue → 200 fast.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const env = getEnv();

  const signature = req.headers.get("x-hub-signature-256");
  if (!env.META_APP_SECRET || !verifyWebhookSignature(rawBody, signature, env.META_APP_SECRET)) {
    log.warn({ event: "facebook.webhook.rejected", hasSignature: Boolean(signature) });
    return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn("facebook.webhook.malformed_json");
    return NextResponse.json({ ok: true });
  }

  const result = await ingestMetaWebhook(prisma, payload);
  // Unknown pages / non-page objects: acknowledge (200) with no processing.
  return NextResponse.json({ ok: true, status: result.status });
}
