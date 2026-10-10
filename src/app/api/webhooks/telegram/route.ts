import { NextRequest, NextResponse } from "next/server";
import { ingestTelegramWebhook } from "@/modules/channels/telegram/webhook";
import { childLogger } from "@/core/logger";
import { prisma } from "@/core/db/prisma";

const log = childLogger("webhooks.telegram");

export const runtime = "nodejs";

/**
 * POST — Telegram receiver. No GET challenge exists on Bot API webhooks;
 * authenticity comes from the per-channel secret header (checked inside
 * ingest against the stored channel secret). Always 200 unless malformed.
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  let payload: unknown;
  try {
    payload = JSON.parse(await req.text());
  } catch {
    log.warn("telegram.webhook.malformed_json");
    return NextResponse.json({ ok: true });
  }

  const result = await ingestTelegramWebhook(prisma, payload, secret);
  return NextResponse.json({ ok: true, status: result.status });
}
