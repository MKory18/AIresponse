import { NextRequest, NextResponse } from "next/server";
import { childLogger } from "@/core/logger";
import { verifyOmsWebhookSignature } from "@/modules/oms/client";
import { decryptSecret } from "@/core/crypto";
import { handleOmsStatusChanged, type OmsStatusWebhook } from "@/modules/oms/webhook";
import { prisma } from "@/core/db/prisma";

const log = childLogger("webhooks.oms");

export const runtime = "nodejs";

/**
 * OMS → engine webhook: order-status-changed.
 * Same trusted receive path as Meta webhooks: HMAC signature over the raw
 * body with the workspace's OMS token → persist → update order → 200 fast.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-oms-signature");

  let parsed: OmsStatusWebhook;
  try {
    parsed = JSON.parse(rawBody) as OmsStatusWebhook;
  } catch {
    log.warn("oms.webhook.malformed_json");
    return NextResponse.json({ error: "MALFORMED_JSON" }, { status: 400 });
  }

  const conn = await prisma.omsConnection.findUnique({
    where: { workspaceId: parsed.workspaceId },
  });
  if (!conn || !conn.isActive) {
    log.warn({ workspaceId: parsed.workspaceId }, "oms.webhook.no_connection");
    return NextResponse.json({ error: "OMS_NOT_CONFIGURED" }, { status: 404 });
  }

  if (!verifyOmsWebhookSignature(rawBody, signature, decryptSecret(conn.tokenEncrypted))) {
    log.warn({ workspaceId: parsed.workspaceId }, "oms.webhook.rejected_signature");
    return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
  }

  if (parsed.event !== "order-status-changed" || !parsed.omsOrderId) {
    return NextResponse.json({ error: "UNSUPPORTED_EVENT" }, { status: 400 });
  }

  try {
    const result = await handleOmsStatusChanged(prisma, parsed);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ err }, "oms.webhook.error");
    return NextResponse.json({ error: "OMS_WEBHOOK_ERROR" }, { status: 500 });
  }
}
