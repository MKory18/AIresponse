import { NextRequest, NextResponse } from "next/server";
import { childLogger } from "@/core/logger";
import { prisma } from "@/core/db/prisma";
import { decryptSecret } from "@/core/crypto";
import { verifyZakiSignature } from "@/modules/integrations/signing";
import { handleOmsAppWebhook, omsAppEnvelopeSchema } from "@/modules/oms/app-webhook";
import type { Db } from "@/modules/customers/service";

const log = childLogger("webhooks.oms-app");

export const runtime = "nodejs";

/**
 * P12 — استقبال أحداث تطبيقات الـ OMS الحقيقي (التسجيل من شاشة «التطبيقات»
 * بالـ OMS: رابط الويبهوك = هذا المسار بمفتاح الاتصال، والأحداث الستة).
 *
 * الثقة: المفتاح بالمسار يحدد الاتصال (ليس سرًا)، والسر zk_… المشفّر عندنا
 * يتحقق من X-Zaki-Signature على "<timestamp>.<body>" (الوقت بالميلي ثانية
 * كما يرسله الـ OMS) — توقيع غلط أو أقدم من 5 دقايق = 401 بلا أي أثر.
 * طلب ليس لنا = 200 «تجاهل» حتى لا يعيد الـ OMS المحاولة عليه ست ساعات.
 */
export async function POST(
  req: NextRequest,
  routeCtx?: { params: Promise<Record<string, string | string[]>> | Record<string, string | string[]> }
) {
  const params = (await routeCtx?.params) ?? {};
  const key = typeof params.key === "string" ? params.key : "";
  const rawBody = await req.text();
  if (!key || !/^[A-Za-z0-9_-]{16,64}$/.test(key)) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const conn = (await prisma.omsConnection.findUnique({ where: { webhookKey: key } })) as
    | { id: string; workspaceId: string; isActive: boolean; webhookSecretEncrypted: string | null }
    | null;
  if (!conn || !conn.isActive) {
    log.warn("oms.app_webhook.unknown_key");
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  if (!conn.webhookSecretEncrypted) {
    log.warn({ workspaceId: conn.workspaceId }, "oms.app_webhook.secret_not_set");
    return NextResponse.json({ error: "WEBHOOK_SECRET_NOT_SET" }, { status: 401 });
  }
  let secret: string;
  try {
    secret = decryptSecret(conn.webhookSecretEncrypted);
  } catch {
    return NextResponse.json({ error: "WEBHOOK_SECRET_UNREADABLE" }, { status: 401 });
  }
  const verdict = verifyZakiSignature({
    secret,
    timestampHeader: req.headers.get("x-zaki-timestamp"),
    signatureHeader: req.headers.get("x-zaki-signature"),
    rawBody,
  });
  if (!verdict.ok) {
    log.warn({ workspaceId: conn.workspaceId, reason: verdict.reason }, "oms.app_webhook.rejected_signature");
    return NextResponse.json({ error: "INVALID_SIGNATURE", reason: verdict.reason }, { status: 401 });
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "MALFORMED_JSON" }, { status: 400 });
  }
  const parsed = omsAppEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_ENVELOPE" }, { status: 400 });
  }
  const deliveryId = req.headers.get("x-zaki-delivery")?.trim().slice(0, 80) || null;

  try {
    const result = await handleOmsAppWebhook(prisma as unknown as Db, {
      connection: { id: conn.id, workspaceId: conn.workspaceId },
      envelope: parsed.data,
      deliveryId,
    });
    await prisma.omsConnection
      .update({ where: { id: conn.id }, data: { lastWebhookAt: new Date() } })
      .catch(() => undefined);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    log.error({ err, workspaceId: conn.workspaceId }, "oms.app_webhook.error");
    // 500 → الـ OMS يعيد المحاولة حسب جدوله (30ث … 6 ساعات).
    return NextResponse.json({ error: "OMS_WEBHOOK_ERROR" }, { status: 500 });
  }
}
