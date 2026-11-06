-- قرار المالك: كل منتج = مسودة مستقلة (لا سلة منتجات في مسودة واحدة).
--
-- نحتاج أكثر من مسودة لنفس المحادثة، فالقيد الفريد القديم (conversationId)
-- يُستبدل بقيد مركّب (conversationId, sequence). الصفوف الموجودة تأخذ 1.
-- إضافي فقط: لا حذف أعمدة/بيانات.

ALTER TABLE "OrderDraft" ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 1;

DROP INDEX "OrderDraft_conversationId_key";

CREATE UNIQUE INDEX "OrderDraft_conversationId_sequence_key"
  ON "OrderDraft"("conversationId", "sequence");
