import { AppError, NotFoundError } from "@/core/errors";

/**
 * شيل صفحة موقوفة من القائمة — بلا ما تمس ولا محادثة.
 *
 * ⚠️ حذف صف القناة فعليًا بيجرّ معه **كل محادثاتها** (`onDelete: Cascade`
 * على `Conversation.channel`) — يعني سجل الزبائن والطلبات بيروح بصمت.
 * 🔧 منعلّم الصف `archivedAt` فبيختفي من قائمة القنوات، والمحادثات والطلبات
 * بتضل موجودة ومقروءة زي ما هي. وأي ربط جديد لنفس الصفحة بيرجّعها.
 *
 * ولا صفحة شغّالة بتنشال: `DISCONNECTED` بس — وإلا صفحة بترد على الزبائن
 * بتختفي من عين المالك وهي شغّالة.
 */

export interface ArchivableChannel {
  id: string;
  status: string;
  archivedAt?: Date | null;
}

/** شكل فضفاض عن قصد: بيقبل Prisma الحقيقي وقاعدة الاختبار سوا. */
type ChannelDb = {
  channel: {
    findFirst: (args: never) => Promise<unknown>;
    update: (args: never) => Promise<unknown>;
  };
};

/** الصفحات اللي بتنعرض بالقائمة: كل شي ما عدا المؤرشف. */
export function visibleChannelsWhere(workspaceId: string) {
  return { workspaceId, type: "FACEBOOK" as const, archivedAt: null };
}

/** صفحة بتنشال من القائمة؟ الموقوفة بس. */
export function canArchive(channel: { status: string }): boolean {
  return channel.status === "DISCONNECTED";
}

export async function archiveFacebookPage(
  db: ChannelDb,
  params: { workspaceId: string; pageId: string }
): Promise<{ channelId: string; archivedAt: Date }> {
  const channel = (await db.channel.findFirst({
    where: { workspaceId: params.workspaceId, type: "FACEBOOK", externalId: params.pageId },
  } as never)) as ArchivableChannel | null;
  if (!channel || channel.archivedAt) throw new NotFoundError("Facebook channel");
  if (!canArchive(channel)) {
    throw new AppError("الصفحة لسا مربوطة — أزل الربط أولًا قبل ما تشيلها من القائمة", 422, "CHANNEL_STILL_CONNECTED");
  }
  const archivedAt = new Date();
  await db.channel.update({ where: { id: channel.id }, data: { archivedAt } } as never);
  return { channelId: channel.id, archivedAt };
}
