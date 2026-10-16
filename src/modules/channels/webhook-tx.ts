import type { Db } from "@/modules/customers/service";

type TxDb = Db;

/**
 * OCR-2026-10-16 (سباق متوسط): نافذة «إنشاء حدث الويب هوك ← إدراج المهمة
 * في الطابور» كانت تضيّع حدث زبون كاملًا لو انهار الحارث بينهما — الصف
 * شكّل ما وصل ولا مهمة تحمّله. الاصطلاح هنا: إنشاء + طابور (أو علامة
 * إنجاز) داخل معاملة تفاعلية واحدة عندما تتوفر؛ وعلى قواعد الاختبار
 * الذاكرية (بلا $transaction) يسير التسلسل القديم نفسه — سلوك مثبت
 * للاختبارات القائمة بلا تغيير.
 */
export async function atomically<T>(db: Db, fn: (tx: TxDb) => Promise<T>): Promise<T> {
  const anyDb = db as unknown as {
    $transaction?: <U>(f: (tx: TxDb) => Promise<U>) => Promise<U>;
  };
  if (typeof anyDb.$transaction === "function") {
    return anyDb.$transaction(fn);
  }
  return fn(db);
}
