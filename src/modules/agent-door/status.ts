import type { Db } from "@/modules/customers/service";
import { computeCapacity, capacityLevel } from "@/modules/integrations/capacity";
import { getIntegrationSettings } from "@/modules/integrations/settings";
import { channelKey, isoInZone } from "@/modules/integrations/format";
import { ZAKI_SYSTEMS, isZakiSystem, type ZakiSystem } from "@/modules/integrations/systems";
import { resolvePeriod } from "./period";
import { inboxSummary, salesFunnel, DEFAULT_SLA_MIN } from "./metrics";
import { expireStaleDrafts } from "./drafts";
import { redactContacts } from "@/modules/integrations/pii-guard";

/**
 * P12 — الأدوات القياسية بكل نظام (agent-door/v1 §7):
 * get_status_summary · list_owner_queue · get_draft_status.
 * الجسر يستخدمها بأدواته المجمّعة (الموجز الصباحي · بانتظارك).
 */

export const REPLIES_VERSION = "1.12.0";

function appUrl(): string {
  return (process.env.APP_URL?.trim() || "").replace(/\/+$/, "");
}

export function link(path: string): string {
  const base = appUrl();
  return base ? `${base}${path}` : path;
}

export async function statusSummary(db: Db, workspaceId: string, tz: string, now = new Date()) {
  const settings = await getIntegrationSettings(db, workspaceId);
  const [cap, inbox, funnel] = await Promise.all([
    computeCapacity(db, workspaceId, now),
    inboxSummary(db, workspaceId, resolvePeriod({ period: "yesterday" }, tz, now), tz, { slaMin: DEFAULT_SLA_MIN, now }),
    salesFunnel(db, workspaceId, resolvePeriod({ period: "yesterday" }, tz, now), tz, null),
  ]);
  const level = capacityLevel(cap, {
    unanswered: settings.capacityUnansweredWarn,
    p50: settings.capacityP50WarnMin,
    multiplier: settings.capacityCriticalMultiplier,
  });
  const asOf = isoInZone(now, tz);
  const conv = funnel.conversations > 0 ? Math.round((funnel.orders_confirmed / funnel.conversations) * 1000) / 10 : null;
  const counters = [
    { key: "conversations_yesterday", label_ar: "محادثات مبارح", value: String(inbox.conversations), unit: "count", source: "computed", as_of: asOf },
    {
      key: "first_response_p50_24h",
      label_ar: "وسيط أول رد (24 ساعة)",
      value: cap.first_response_p50_min === null ? "—" : String(cap.first_response_p50_min),
      unit: "min",
      source: "computed",
      as_of: asOf,
    },
    { key: "unanswered_now", label_ar: "بلا رد الآن", value: String(cap.unanswered), unit: "count", source: "computed", as_of: asOf },
    { key: "over_sla_yesterday", label_ar: "فوق المهلة مبارح", value: String(inbox.over_sla), unit: "count", source: "computed", as_of: asOf },
    {
      key: "conversion_yesterday",
      label_ar: "تحويل المحادثة لطلب مؤكد مبارح",
      value: conv === null ? "—" : conv.toFixed(1),
      unit: "percent",
      source: "computed",
      as_of: asOf,
    },
    { key: "capacity_level", label_ar: "إنذار القدرة", value: level, unit: "level", source: "computed", as_of: asOf },
  ];

  const warnings: string[] = [];
  const oms = (await (db as unknown as { omsConnection?: { findUnique: (a: unknown) => Promise<unknown> } }).omsConnection?.findUnique({
    where: { workspaceId },
  })) as { mode?: string; isActive?: boolean; lastWebhookAt?: Date | string | null; lastProductSyncAt?: Date | string | null; lastError?: string | null } | null | undefined;
  if (!oms || !oms.isActive) warnings.push("الـ OMS غير مربوط — الطلبات المؤكدة ما بتنتقل");
  else if (oms.mode === "manual") {
    const waiting = await db.order.count({
      where: {
        workspaceId,
        confirmationStatus: { in: ["CONFIRMED_BY_CUSTOMER", "CONFIRMED_BY_AGENT"] },
        omsOrderId: null,
        omsOrderNumber: null,
        status: { notIn: ["CANCELLED", "FAILED"] },
      } as never,
    });
    if (waiting > 0) warnings.push(`الـ OMS بوضع يدوي — ${waiting} طلب مؤكد بانتظار النسخ للـ OMS`);
  }
  if (level !== "ok") warnings.push(level === "critical" ? "إنذار قدرة حرج: الرسائل بلا رد فوق الحد بكثير" : "إنذار قدرة: الرسائل بلا رد فوق الحد");
  const failed = await (db as unknown as { integrationDelivery?: { count: (a: unknown) => Promise<number> } }).integrationDelivery?.count({
    where: { workspaceId, status: "FAILED", createdAt: { gte: new Date(now.getTime() - 24 * 3600_000) } },
  });
  if (failed && failed > 0) warnings.push(`${failed} رسالة ربط فشلت آخر 24 ساعة — راجع صفحة الربط`);

  // صحة القنوات: قناة بخطأ أو توكنها انتهى = الردود عليها واقفة.
  const channels = (await db.channel.findMany({
    where: { workspaceId, status: { in: ["CONNECTED", "ERROR"] } } as never,
    select: { id: true, type: true, status: true, displayName: true },
  })) as Array<{ id: string; type: string; status: string; displayName: string }>;
  const accounts = channels.length
    ? ((await db.channelAccount.findMany({
        where: { channelId: { in: channels.map((c) => c.id) } },
        select: { channelId: true, tokenExpiresAt: true },
      })) as Array<{ channelId: string; tokenExpiresAt: Date | string | null }>)
    : [];
  const expiryById = new Map(accounts.map((a) => [a.channelId, a.tokenExpiresAt ? new Date(a.tokenExpiresAt).getTime() : null]));
  let channelDown = false;
  for (const c of channels) {
    const kind = channelKey(c.type);
    const exp = expiryById.get(c.id) ?? null;
    if (c.status === "ERROR") {
      channelDown = true;
      warnings.push(`قناة ${kind} فيها خطأ ربط — الردود عليها ممكن تكون واقفة`);
    } else if (exp !== null && exp <= now.getTime()) {
      channelDown = true;
      warnings.push(`قناة ${kind} انتهى توكنها — أعد الربط`);
    } else if (exp !== null && exp - now.getTime() <= 72 * 3600_000) {
      warnings.push(`قناة ${kind} توكنها بينتهي خلال ${Math.max(1, Math.round((exp - now.getTime()) / 3600_000))} ساعة`);
    }
  }

  const conns = ((await (db as unknown as { integrationConnection?: { findMany: (a: unknown) => Promise<unknown> } }).integrationConnection?.findMany({
    where: { workspaceId, enabled: true },
    select: { system: true, lastOkAt: true },
  })) ?? []) as Array<{ system: string; lastOkAt: Date | string | null }>;
  // كل الأنظمة بمفاتيح ثابتة (مخطط حرفي): null = ما في مزامنة ناجحة لسا أو مش مربوط.
  const lastSync = Object.fromEntries(ZAKI_SYSTEMS.map((k) => [k, null])) as Record<ZakiSystem, string | null>;
  const omsAt = oms ? oms.lastWebhookAt ?? oms.lastProductSyncAt ?? null : null;
  lastSync.oms = omsAt ? isoInZone(new Date(omsAt), tz) : null;
  for (const c of conns) {
    if (isZakiSystem(c.system) && c.system !== "oms") lastSync[c.system] = c.lastOkAt ? isoInZone(new Date(c.lastOkAt), tz) : null;
  }

  return {
    healthy: level !== "critical" && !channelDown,
    version: REPLIES_VERSION,
    last_sync: lastSync,
    counters,
    warnings_ar: warnings,
  };
}

export async function ownerQueue(db: Db, workspaceId: string, now = new Date(), limit = 20) {
  await expireStaleDrafts(db, workspaceId, now);
  const hours = (d: Date | string) => Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 3600_000));
  const items: Array<{ type: string; title_ar: string; age_hours: number; url: string }> = [];

  const drafts = (await (db as unknown as { agentDraft?: { findMany: (a: unknown) => Promise<unknown> } }).agentDraft?.findMany({
    where: { workspaceId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 30,
    select: { id: true, kind: true, title: true, createdAt: true },
  })) as Array<{ id: string; kind: string; title: string; createdAt: Date | string }> | undefined;
  for (const d of drafts ?? []) {
    items.push({
      type: `draft.${d.kind}`,
      title_ar: redactContacts(d.title).slice(0, 160),
      age_hours: hours(d.createdAt),
      url: link(`/settings/agents?draft=${encodeURIComponent(d.id)}`),
    });
  }
  const campaigns = (await db.campaign.findMany({
    where: { workspaceId, status: "READY", approvedAt: null },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, name: true, createdAt: true },
  })) as Array<{ id: string; name: string; createdAt: Date | string }>;
  for (const c of campaigns) {
    items.push({ type: "campaign.approval", title_ar: redactContacts(`اعتماد حملة: ${c.name}`).slice(0, 160), age_hours: hours(c.createdAt), url: link("/campaigns") });
  }
  const discounts = (await db.discountApproval.findMany({
    where: { workspaceId, status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { id: true, productName: true, discountPercent: true, createdAt: true },
  })) as Array<{ id: string; productName: string; discountPercent: unknown; createdAt: Date | string }>;
  for (const d of discounts) {
    items.push({
      type: "discount.approval",
      title_ar: redactContacts(`خصم ${String(d.discountPercent)}% على ${d.productName}`).slice(0, 160),
      age_hours: hours(d.createdAt),
      url: link("/conversations"),
    });
  }
  const oms = (await (db as unknown as { omsConnection?: { findUnique: (a: unknown) => Promise<unknown> } }).omsConnection?.findUnique({
    where: { workspaceId },
  })) as { mode?: string; isActive?: boolean } | null | undefined;
  if (oms?.isActive && oms.mode === "manual") {
    const pending = (await db.order.findMany({
      where: {
        workspaceId,
        confirmationStatus: { in: ["CONFIRMED_BY_CUSTOMER", "CONFIRMED_BY_AGENT"] },
        omsOrderId: null,
        omsOrderNumber: null,
        status: { notIn: ["CANCELLED", "FAILED"] },
      } as never,
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { id: true, orderNumber: true, createdAt: true },
    })) as Array<{ id: string; orderNumber: string; createdAt: Date | string }>;
    for (const o of pending) {
      items.push({ type: "oms.manual_handoff", title_ar: redactContacts(`انسخ الطلب ${o.orderNumber} للـ OMS`), age_hours: hours(o.createdAt), url: link(`/orders/${o.id}`) });
    }
  }
  items.sort((a, b) => b.age_hours - a.age_hours);
  return { items: items.slice(0, Math.min(Math.max(limit, 1), 100)), total: items.length };
}

export const DRAFT_STATUS_MAP: Record<string, "pending" | "approved" | "edited" | "rejected" | "expired"> = {
  PENDING: "pending",
  APPROVED: "approved",
  EDITED: "edited",
  REJECTED: "rejected",
  EXPIRED: "expired",
};

/** مسودات هالتوكن (آخر «days» يوم، أو مسودة وحدة بالرقم) بحالتها ووقت القرار. */
export async function draftStatus(
  db: Db,
  workspaceId: string,
  tokenId: string,
  opts: { draftId?: string | null; days?: number; tz: string; now?: Date }
) {
  const now = opts.now ?? new Date();
  await expireStaleDrafts(db, workspaceId, now);
  const days = Math.min(Math.max(opts.days ?? 7, 1), 90);
  const rows = (await (db as unknown as { agentDraft: { findMany: (a: unknown) => Promise<unknown> } }).agentDraft.findMany({
    where: {
      workspaceId,
      tokenId,
      ...(opts.draftId ? { id: opts.draftId } : { createdAt: { gte: new Date(now.getTime() - days * 24 * 3600_000) } }),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, kind: true, status: true, createdAt: true, decidedAt: true },
  })) as Array<{ id: string; kind: string; status: string; createdAt: Date | string; decidedAt: Date | string | null }>;
  return {
    drafts: rows.map((r) => ({
      draft_id: r.id,
      kind: r.kind,
      status: DRAFT_STATUS_MAP[r.status] ?? "pending",
      created_at: isoInZone(new Date(r.createdAt), opts.tz),
      decided_at: r.decidedAt ? isoInZone(new Date(r.decidedAt), opts.tz) : null,
    })),
  };
}
