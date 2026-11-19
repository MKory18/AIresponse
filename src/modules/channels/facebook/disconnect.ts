import { decryptSecret, encryptSecret } from "@/core/crypto";
import { NotFoundError } from "@/core/errors";

/**
 * فصل صفحة فيسبوك — الدالة الوحيدة لهالشغلة (مسار الفصل ومسار الحذف بيستعملوها).
 *
 * المحادثات والطلبات بتضل: بس الربط بيتعطّل. وبنحاول نلغي اشتراك الصفحة من
 * تطبيق ميتا عشان توقف الـwebhook، بس ما بنوقف الفصل لو ميتا فشلت —
 * وهاد الحالة الطبيعية للصفحة القديمة اللي ميتا سحبت وصولها (الخطأ 190).
 * بوابة الاستقبال أصلًا بترمي أي حدث لقناة `status !== CONNECTED`.
 */

/** شكل فضفاض عن قصد: بيقبل Prisma الحقيقي وقاعدة الاختبار سوا. */
type DisconnectDb = {
  channel: {
    findFirst: (args: never) => Promise<unknown>;
    update: (args: never) => Promise<unknown>;
  };
  channelAccount: {
    update: (args: never) => Promise<unknown>;
  };
};

export interface PageUnsubscriber {
  unsubscribePageFromApp: (pageAccessToken: string, pageId: string) => Promise<unknown>;
}

export async function disconnectFacebookPage(
  db: DisconnectDb,
  client: PageUnsubscriber,
  params: { workspaceId: string; pageId: string }
): Promise<{ channelId: string }> {
  const channel = (await db.channel.findFirst({
    where: { workspaceId: params.workspaceId, type: "FACEBOOK", externalId: params.pageId },
    include: { account: true },
  } as never)) as { id: string; account: { id: string; encryptedCredentials: string } | null } | null;
  if (!channel) throw new NotFoundError("Facebook channel");

  // Best-effort Meta unsubscribe before revoking the token.
  if (channel.account) {
    try {
      const token = decryptSecret(channel.account.encryptedCredentials);
      if (token !== "revoked") await client.unsubscribePageFromApp(token, params.pageId);
    } catch {
      // Never block disconnect on Meta API failure.
    }
  }

  await db.channel.update({ where: { id: channel.id }, data: { status: "DISCONNECTED" } } as never);
  if (channel.account) {
    // Destroy the stored token (encrypted) — connection is gone.
    // tokenExpiresAt=now() makes health/policy report expired, not LONG_LIVED.
    await db.channelAccount.update({
      where: { id: channel.account.id },
      data: { encryptedCredentials: encryptSecret("revoked"), tokenExpiresAt: new Date() },
    } as never);
  }
  return { channelId: channel.id };
}
