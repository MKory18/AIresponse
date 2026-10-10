import { NextRequest, NextResponse } from "next/server";
import { childLogger } from "@/core/logger";
import { verifyOmsWebhookSignature } from "@/modules/oms/client";
import { decryptSecret } from "@/core/crypto";
import { handleOmsStatusChanged, OmsWorkspaceMismatchError, type OmsStatusWebhook } from "@/modules/oms/webhook";
import { prisma } from "@/core/db/prisma";

const log = childLogger("webhooks.oms");

export const runtime = "nodejs";

/**
 * OMS → engine webhook: order-status-changed.
 * P2 trust model: the workspace is derived from the ORDER row (lookup by
 * omsOrderId) — the payload's workspaceId is an untrusted hint. Signature
 * verification uses the derived workspace's connection. Unknown orders and
 * bad signatures are rejected with zero side effects.
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

  if (parsed.event !== "order-status-changed" || !parsed.omsOrderId) {
    return NextResponse.json({ error: "UNSUPPORTED_EVENT" }, { status: 400 });
  }

  // Derive the workspace from the order — never from the payload.
  const order = await prisma.order.findUnique({
    where: { omsOrderId: parsed.omsOrderId },
    select: { id: true, workspaceId: true },
  });
  if (!order) {
    log.warn("oms.webhook.unknown_order");
    return NextResponse.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
  }
  if (parsed.workspaceId && parsed.workspaceId !== order.workspaceId) {
    log.warn("oms.webhook.workspace_mismatch");
    return NextResponse.json({ error: new OmsWorkspaceMismatchError().code }, { status: 404 });
  }

  const conn = await prisma.omsConnection.findUnique({
    where: { workspaceId: order.workspaceId },
  });
  if (!conn || !conn.isActive) {
    log.warn({ workspaceId: order.workspaceId }, "oms.webhook.no_connection");
    return NextResponse.json({ error: "OMS_NOT_CONFIGURED" }, { status: 404 });
  }

  if (!verifyOmsWebhookSignature(rawBody, signature, decryptSecret(conn.tokenEncrypted))) {
    log.warn({ workspaceId: order.workspaceId }, "oms.webhook.rejected_signature");
    return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
  }

  try {
    const result = await handleOmsStatusChanged(prisma, { ...parsed, workspaceId: order.workspaceId });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ err }, "oms.webhook.error");
    return NextResponse.json({ error: "OMS_WEBHOOK_ERROR" }, { status: 500 });
  }
}
