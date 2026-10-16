import { NextRequest, NextResponse } from "next/server";
import { childLogger } from "@/core/logger";
import { verifyOmsWebhookSignature } from "@/modules/oms/client";
import { resolveOmsWebhookSecret } from "@/modules/oms/connection";
import { handleOmsStatusChanged, type OmsStatusWebhook } from "@/modules/oms/webhook";
import { prisma } from "@/core/db/prisma";
import { rateLimitDb } from "@/core/api/rate-limit";

const log = childLogger("webhooks.oms");

/** رد موحّد 404 — بلا فراغ معرفة (طلب/مساحة/اتصال) لمهاجم بلا توقيع. */
function omsNotFound(): NextResponse {
  return NextResponse.json({ error: "OMS_NOT_FOUND" }, { status: 404 });
}

export const runtime = "nodejs";

/**
 * OMS → engine webhook: order-status-changed.
 * P2 trust model: the workspace is derived from the ORDER row (lookup by
 * omsOrderId) — the payload's workspaceId is an untrusted hint. Signature
 * verification uses the derived workspace's connection SECRET (webhook
 * secret first; legacy api rows keep their real token). Manual-mode rows get
 * no secret at all — the placeholder token is public and must never verify.
 * Unknown orders, mismatches and missing secrets are uniform, zero side
 * effects, and rate-limited to blunt the enumeration oracle.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-oms-signature");

  // Shield: keep immature/MitM traffic cheap. Order flows stay well under it.
  // (Skipped in tests: the in-memory route suites have no rate-limit store.)
  if (process.env.NODE_ENV !== "test") {
    try {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
      await rateLimitDb(`${ip}:oms-webhook`, 300, 60_000);
    } catch {
      // Storage hiccup on a hardening shield — never block the real OMS.
    }
  }

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
    return omsNotFound();
  }
  if (parsed.workspaceId && parsed.workspaceId !== order.workspaceId) {
    log.warn("oms.webhook.workspace_mismatch");
    return omsNotFound();
  }

  const conn = await prisma.omsConnection.findUnique({
    where: { workspaceId: order.workspaceId },
  });
  const secret = conn?.isActive ? resolveOmsWebhookSecret(conn) : null;
  if (!conn || !conn.isActive || !secret) {
    log.warn({ workspaceId: order.workspaceId }, "oms.webhook.no_connection_or_secret");
    return omsNotFound();
  }

  if (!verifyOmsWebhookSignature(rawBody, signature, secret)) {
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
