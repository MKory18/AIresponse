import { NextRequest, NextResponse } from "next/server";
import { verifyWebhookChallenge } from "@/modules/channels/facebook/normalizer";
import { ingestWhatsAppWebhook } from "@/modules/channels/whatsapp/webhook";
import { verifyWhatsAppSignature } from "@/modules/channels/whatsapp/normalizer";
import { childLogger } from "@/core/logger";
import { getEnv } from "@/core/env";
import { prisma } from "@/core/db/prisma";

const log = childLogger("webhooks.whatsapp");

export const runtime = "nodejs";

/** Cloud API subscription verification (GET hub challenge). */
export async function GET(req: NextRequest) {
  const result = verifyWebhookChallenge(req.nextUrl.searchParams);
  if (!result.ok) {
    log.warn("webhook_verification_failed");
    return NextResponse.json({ error: "VERIFICATION_FAILED" }, { status: 403 });
  }
  return new NextResponse(result.challenge, { status: 200 });
}

/**
 * POST — WhatsApp receiver.
 * verify signature → persist raw (idempotent) → route number → enqueue → 200.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const env = getEnv();

  const signature = req.headers.get("x-hub-signature-256");
  if (!env.META_APP_SECRET || !verifyWhatsAppSignature(rawBody, signature, env.META_APP_SECRET)) {
    log.warn({ hasSignature: Boolean(signature) }, "whatsapp.webhook.rejected");
    return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.warn("whatsapp.webhook.malformed_json");
    return NextResponse.json({ ok: true });
  }

  const result = await ingestWhatsAppWebhook(prisma, payload);
  return NextResponse.json({ ok: true, status: result.status });
}
