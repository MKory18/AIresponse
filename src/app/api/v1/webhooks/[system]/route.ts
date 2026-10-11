import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AppError } from "@/core/errors";
import { childLogger } from "@/core/logger";
import { prisma } from "@/core/db/prisma";
import type { Db } from "@/modules/customers/service";
import { isGenericSystem, INBOUND_EVENT_TYPES } from "@/modules/integrations/systems";
import { getDecryptedConnection } from "@/modules/integrations/connections";
import { verifyZakiSignature } from "@/modules/integrations/signing";
import { findPii } from "@/modules/integrations/pii-guard";
import { onComplianceUpdated } from "@/modules/integrations/compliance";
import { sanitizeRequestId, v1Error } from "@/modules/integrations/system-handler";

const log = childLogger("webhooks.zaki");

export const runtime = "nodejs";

const envelopeSchema = z.object({
  event_id: z.string().min(4).max(80),
  type: z.string().min(3).max(64),
  occurred_at: z.string().max(64).optional(),
  data: z.record(z.unknown()),
});

/**
 * P12 — استقبال أحداث أنظمة المنظومة: POST /api/v1/webhooks/{system}?ws={workspaceSlug}
 * نفس قاعدة المنظومة: HMAC-SHA256(سر الاتصال، "<timestamp>.<body>") ·
 * أقدم من 5 دقايق = 401 · event_id مكرر = 200 بلا معالجة · شكل غلط أو بيانات
 * شخصية = 422. المساحة من ?ws= ثم يُتحقق بسر اتصالها هي — لا ثقة بالجسم.
 */
export async function POST(
  req: NextRequest,
  routeCtx?: { params: Promise<Record<string, string | string[]>> | Record<string, string | string[]> }
) {
  const requestId = sanitizeRequestId(req.headers.get("x-request-id"));
  const params = (await routeCtx?.params) ?? {};
  const system = typeof params.system === "string" ? params.system : "";
  const rawBody = await req.text();
  if (!isGenericSystem(system) || !INBOUND_EVENT_TYPES[system]) {
    return v1Error(404, "NOT_FOUND", "نظام غير معروف لهذا المسار", requestId);
  }
  const slug = new URL(req.url).searchParams.get("ws") ?? "";
  if (!/^[a-z0-9-]{1,64}$/i.test(slug)) return v1Error(404, "NOT_FOUND", "مساحة العمل ناقصة (?ws=)", requestId);
  const ws = await prisma.workspace.findUnique({ where: { slug }, select: { id: true } });
  if (!ws) return v1Error(404, "NOT_FOUND", "مساحة العمل غير معروفة", requestId);
  const db = prisma as unknown as Db;
  const conn = await getDecryptedConnection(db, ws.id, system);
  if (!conn || !conn.enabled || !conn.eventsSecret) {
    return v1Error(401, "UNAUTHORIZED", "الاتصال غير مضبوط أو موقوف", requestId);
  }
  const verdict = verifyZakiSignature({
    secret: conn.eventsSecret,
    timestampHeader: req.headers.get("x-zaki-timestamp"),
    signatureHeader: req.headers.get("x-zaki-signature"),
    rawBody,
  });
  if (!verdict.ok) {
    log.warn({ system, reason: verdict.reason }, "zaki_webhook_rejected");
    return v1Error(401, "UNAUTHORIZED", `توقيع أو وقت غلط (${verdict.reason})`, requestId);
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return v1Error(422, "VALIDATION_FAILED", "ليس JSON", requestId);
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) return v1Error(422, "VALIDATION_FAILED", "شكل الحدث غلط", requestId);
  const env = parsed.data;
  if (!INBOUND_EVENT_TYPES[system]!.includes(env.type)) {
    return v1Error(422, "VALIDATION_FAILED", `الحدث ${env.type} غير مدعوم من ${system}`, requestId);
  }
  if (findPii(env.data).length > 0) {
    return v1Error(422, "PII_BLOCKED", "الحدث فيه بيانات شخصية — مرفوض", requestId);
  }
  // عدم التكرار لكل مساحة: نفس الحدث من نفس النظام لمساحتين = حدثين (كل
  // مساحة بتعيد قراءة قواعدها) — مش «مكرر» للتانية.
  const source = `zaki:${system}:${ws.id}`;
  try {
    await prisma.webhookEvent.create({
      data: { workspaceId: ws.id, channelType: "ZAKI", externalEventId: env.event_id, source, payload: env as object },
    });
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      return NextResponse.json({ ok: true, duplicate: true, request_id: requestId }, { headers: { "x-request-id": requestId } });
    }
    throw err;
  }
  try {
    if (system === "s1" && env.type === "compliance.updated") {
      await onComplianceUpdated(db, ws.id, env.event_id, env.data);
    }
    await prisma.webhookEvent.updateMany({ where: { source, externalEventId: env.event_id }, data: { processedAt: new Date() } });
    return NextResponse.json({ ok: true, request_id: requestId }, { headers: { "x-request-id": requestId } });
  } catch (err) {
    // نشيل سجل الحدث غير المعالج حتى إعادة الإرسال تنعالج من جديد.
    await prisma.webhookEvent.deleteMany({ where: { source, externalEventId: env.event_id, processedAt: null } }).catch(() => undefined);
    // خطأ بالحدث نفسه (حقل ناقص مثلًا) = 4xx نهائي: الإعادة ما بتصلّحه.
    if (err instanceof AppError && err.statusCode < 500) {
      log.warn({ system, code: err.code }, "zaki_webhook_rejected_payload");
      return v1Error(err.statusCode, err.code, err.message, requestId);
    }
    log.error({ err, system }, "zaki_webhook_failed");
    // خطأ عندنا: 500 حتى يعيد النظام المرسل (والمكرر بعدها 200).
    return v1Error(500, "INTERNAL", "خطأ داخلي", requestId);
  }
}
