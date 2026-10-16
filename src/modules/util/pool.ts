/**
 * OCR-2026-10-16 (متوسط): تجميع محدود التوازي بدل الحلقات المتسلسلة
 * البطيئة أو انتشار مهام مئاتها. عدد محدود من الوحدات يُنفّذ بالتوازي،
 * والنتائج بنسق الإدخال، وفشل وحدة لا يوقف البقية — عنوانه يرمى بعد
 * إكمال كل العاملات.
 */
export async function runPool<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  worker: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let next = 0;
  let firstError: unknown = null;

  async function loop(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        if (firstError === null) firstError = err;
        return;
      }
    }
  }

  const workers: Promise<void>[] = [];
  const size = Math.max(1, Math.min(concurrency, items.length));
  for (let k = 0; k < size; k++) workers.push(loop());
  await Promise.all(workers);
  if (firstError !== null) throw firstError;
  return results;
}
