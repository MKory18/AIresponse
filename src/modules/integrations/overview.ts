import { AppError, NotFoundError } from "@/core/errors";
import { recordAudit } from "@/modules/audit/service";
import type { ActorContext, Db } from "@/modules/customers/service";
import { getOmsConnectionView } from "@/modules/oms/connection";
import { MARKETS } from "@/modules/agent-door/metrics";
import { listConnectionViews } from "./connections";
import { deliveryStats } from "./outbox";
import { getIntegrationSettings } from "./settings";
import { GENERIC_SYSTEMS, SYSTEM_SPECS, TOKEN_PRESETS, TOKEN_SYSTEMS } from "./systems";
import { listIntegrationTokens } from "./tokens";

/**
 * P12 — كل ما تحتاجه صفحة «الربط مع الأنظمة» بنداء واحد (بلا أي سر):
 * كل نظام بمواصفته من الكود + اتصاله + صندوق صادره · الـ OMS · الإعدادات ·
 * التوكنات · أسواق القنوات · روابط الاستقبال الجاهزة للنسخ.
 */

function appUrl(): string {
  return (process.env.APP_URL?.trim() || "").replace(/\/+$/, "");
}

export async function integrationsOverview(db: Db, workspaceId: string) {
  const [connections, oms, settings, tokens, channels, ws] = await Promise.all([
    listConnectionViews(db, workspaceId),
    getOmsConnectionView(db, workspaceId),
    getIntegrationSettings(db, workspaceId),
    listIntegrationTokens(db, workspaceId),
    db.channel.findMany({
      where: { workspaceId },
      select: { id: true, type: true, displayName: true, status: true, market: true },
      orderBy: { createdAt: "asc" },
    }) as Promise<Array<{ id: string; type: string; displayName: string; status: string; market: string | null }>>,
    db.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }) as Promise<{ slug?: string } | null>,
  ]);
  const stats = await Promise.all(GENERIC_SYSTEMS.map((s) => deliveryStats(db, workspaceId, s)));
  const base = appUrl();
  // مدة الاحتفاظ بحمولة أحداث القنوات الخام — إعداد خادم، بتظهر بالملاحظة
  // الحمراء بالصفحة حتى المالك يشوف الرقم الفعلي مش الافتراضي.
  const { retentionDays } = await import("@/modules/channels/webhook-retention");
  const webhookPayloadRetentionDays = retentionDays();
  const slug = ws?.slug ?? "";
  return {
    appUrl: base || null,
    webhookPayloadRetentionDays,
    systems: GENERIC_SYSTEMS.map((key, i) => {
      const spec = SYSTEM_SPECS[key];
      return {
        key,
        nameAr: spec.nameAr,
        summaryAr: spec.summaryAr,
        eventsPath: spec.eventsPath ?? null,
        sendsEvents: [...spec.sendsEvents],
        calls: spec.calls.map((c) => ({ ...c })),
        inbound: spec.inbound.map((c) => ({ ...c })),
        needsToken: spec.needsToken,
        needsEventsSecret: spec.needsEventsSecret,
        connection: connections[i],
        stats: stats[i],
      };
    }),
    oms: { spec: { nameAr: SYSTEM_SPECS.oms.nameAr, summaryAr: SYSTEM_SPECS.oms.summaryAr }, view: oms },
    settings,
    tokens,
    tokenPresets: TOKEN_SYSTEMS.map((s) => ({ system: s, nameAr: TOKEN_PRESETS[s].nameAr, scopes: [...TOKEN_PRESETS[s].scopes] })),
    channels,
    markets: [...MARKETS],
    endpoints: {
      capacity: `${base}/api/v1/capacity`,
      retargetCampaigns: `${base}/api/v1/retarget-campaigns`,
      s1Webhook: slug ? `${base}/api/v1/webhooks/s1?ws=${encodeURIComponent(slug)}` : null,
      agentTools: `${base}/api/agent/tools`,
      agentCall: `${base}/api/agent/call`,
      health: `${base}/api/health`,
    },
  };
}

/** سوق القناة (SY · JO أو بلا) — فلتر market بأدوات الوكلاء. */
export async function setChannelMarket(db: Db, ctx: ActorContext, channelId: string, market: string | null) {
  const value = market ? market.toUpperCase() : null;
  if (value && !(MARKETS as readonly string[]).includes(value)) throw new AppError("سوق غير معروف", 422, "INVALID_MARKET");
  const channel = (await db.channel.findUnique({ where: { id: channelId }, select: { id: true, workspaceId: true } })) as
    | { id: string; workspaceId: string }
    | null;
  if (!channel || channel.workspaceId !== ctx.workspaceId) throw new NotFoundError("Channel");
  await db.channel.update({ where: { id: channelId }, data: { market: value } as never });
  await recordAudit(db, {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    action: "channel.market_set",
    entityType: "Channel",
    entityId: channelId,
    metadata: { market: value },
  });
  return { id: channelId, market: value };
}
