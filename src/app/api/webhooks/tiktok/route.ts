import { NextRequest, NextResponse } from "next/server";
import { ingestTikTokWebhook } from "@/modules/channels/tiktok/webhook";
import { childLogger } from "@/core/logger";
import { prisma } from "@/core/db/prisma";

const log = childLogger("webhooks.tiktok");

export const runtime = "nodejs";

/**
 * POST — TikTok receiver (LOCAL-ONLY surface). The business account is
 * addressed via ?account=<id> configured in the TikTok webhook console;
 * authenticity uses the interim shared secret until the official signing
 * scheme is confirmed for our account (BLOCKED external).
 */
export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-tiktok-secret");
  const account = req.nextUrl.searchParams.get("account");
  let payload: unknown;
  try {
    payload = JSON.parse(await req.text());
  } catch {
    log.warn("tiktok.webhook.malformed_json");
    return NextResponse.json({ ok: true });
  }

  const result = await ingestTikTokWebhook(prisma, payload, secret, account);
  return NextResponse.json({ ok: true, status: result.status });
}
