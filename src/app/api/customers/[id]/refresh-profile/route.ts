import { createHandler, ok } from "@/core/api/handler";
import { prisma } from "@/core/db/prisma";
import { decryptSecret } from "@/core/crypto";
import { recordAudit } from "@/modules/audit/service";
import { getFacebookClient } from "@/modules/channels/facebook/client";
import { resolveSenderName } from "@/modules/channels/facebook/profile";
import { resolveCustomerByChannelIdentity } from "@/modules/customers/service";

/**
 * P21 — تحديث اسم/صورة العميل من فيسبوك عند الطلب (زر بالمحادثة).
 *
 * لماذا: الاسم الحقيقي بيجي من Graph برّا مسار الرد. لو فشل/تأخر (شبكة، صلاحية
 * الصفحة، كاش سلبي 24 ساعة) بيضل العميل بلا اسم. هذا المسار يتجاوز الكاش
 * (force) ويعيد المحاولة فورًا، ثم يرجّع سببًا آمنًا للواجهة (HTTP/كود فقط).
 *
 * لا يرسل شيئًا للزبون، ولا يلمس الطلبات، ولا يعيد التوكن.
 */
export const POST = createHandler(
  { permission: "customers.write", rateLimit: { limit: 5, windowMs: 60_000 } },
  async ({ auth, params }) => {
    const { id } = params as { id: string };
    const workspaceId = auth!.workspaceId;

    const customer = await prisma.customer.findFirst({
      where: { id, workspaceId },
      select: { id: true, name: true, avatarUrl: true },
    });
    if (!customer) {
      return ok({ ok: false, status: "empty", message: "العميل غير موجود." });
    }

    const identity = await prisma.channelIdentity.findFirst({
      where: { customerId: customer.id, workspaceId, channelType: "FACEBOOK" },
      select: { id: true, channelExternalId: true },
    });
    if (!identity) {
      return ok({ ok: false, status: "empty", message: "العميل غير مربوط بهوية فيسبوك." });
    }

    // توكن الصفحة: من آخر محادثة فيسبوك لهذا العميل (الصفحة اللي كلّمها).
    const conversations = await prisma.conversation.findMany({
      where: { customerId: customer.id, workspaceId },
      orderBy: { updatedAt: "desc" },
      take: 10,
      select: { channelId: true },
    });
    const channelIds = [...new Set(conversations.map((c) => c.channelId).filter((v): v is string => Boolean(v)))];
    const channels = channelIds.length
      ? await prisma.channel.findMany({
          where: { id: { in: channelIds }, workspaceId, type: "FACEBOOK" },
          select: { id: true, account: { select: { encryptedCredentials: true } } },
        })
      : [];
    const account = channels.find((c) => c.account?.encryptedCredentials)?.account;

    let pageToken: string | null = null;
    if (account?.encryptedCredentials) {
      try {
        pageToken = decryptSecret(account.encryptedCredentials);
      } catch {
        pageToken = null;
      }
    }
    if (!pageToken) {
      return ok({ ok: false, status: "empty", message: "ما في توكن صفحة فيسبوك متاح لهذا العميل." });
    }

    const result = await resolveSenderName(prisma, {
      workspaceId,
      psid: identity.channelExternalId,
      pageToken,
      client: getFacebookClient(),
      force: true,
    });

    if ((result.status === "ok" || result.status === "cached") && (result.name || result.avatarUrl)) {
      await resolveCustomerByChannelIdentity(prisma, {
        workspaceId,
        channelType: "FACEBOOK",
        externalUserId: identity.channelExternalId,
        displayName: result.name,
        avatarUrl: result.avatarUrl,
      });
    }

    await recordAudit(prisma, {
      workspaceId,
      userId: auth!.userId,
      action: "customer.profile_refreshed",
      entityType: "Customer",
      entityId: customer.id,
      // بلا اسم/صورة أو أي بيانات شخصية — نتيجة تقنية فقط.
      metadata: {
        status: result.status,
        httpStatus: result.httpStatus ?? null,
        errorCode: result.errorCode ?? null,
        gotName: Boolean(result.name),
        gotAvatar: Boolean(result.avatarUrl),
      },
    });

    const message =
      result.status === "ok"
        ? "تم تحديث الاسم والصورة من فيسبوك."
        : result.status === "network"
          ? "تعذّر الوصول لفيسبوك (شبكة/مهلة) — جرّب بعد دقائق."
          : result.status === "cached"
            ? "الاسم محفوظ مسبقًا — ما تغيّر."
            : `فيسبوك ما رجّع اسمًا${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}${
                result.errorCode ? ` · كود ${result.errorCode}` : ""
              }. غالبًا صلاحية الصفحة (pages_user_profile) أو الحساب محظور.`;

    return ok({
      ok: result.status === "ok" && Boolean(result.name || result.avatarUrl),
      name: result.name,
      avatarUrl: result.avatarUrl,
      status: result.status,
      httpStatus: result.httpStatus ?? null,
      errorCode: result.errorCode ?? null,
      message,
    });
  }
);
