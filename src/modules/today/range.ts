/**
 * فترات «اليوم» بتوقيت المساحة (3.3، 05-DASHBOARDS §2): بداية اليوم بمنطقة المساحة مش بـUTC،
 * والفترة السابقة بنفس الطول للمقارنة («▲ 6 عن أمس»).
 */

export type TodayRange = "today" | "yesterday" | "7d" | "30d";
export const TODAY_RANGES: readonly TodayRange[] = ["today", "yesterday", "7d", "30d"];

export function parseRange(v: unknown): TodayRange {
  return TODAY_RANGES.includes(v as TodayRange) ? (v as TodayRange) : "today";
}

const DAY = 86_400_000;

/** فرق المنطقة الزمنية عن UTC (ميلي ثانية) لحظة معينة. */
export function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** بداية اليوم (00:00) بمنطقة المساحة للحظة `at`، كـUTC instant. منطقة مجهولة ← UTC. */
export function startOfDayInZone(at: Date, timeZone: string): Date {
  let tz = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = "UTC";
  }
  const offset = tzOffsetMs(at, tz);
  const local = new Date(at.getTime() + offset);
  const midnightLocalAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // نصحّح بفرق المنطقة عند منتصف الليل نفسه (حالة تغيير التوقيت الصيفي بنص اليوم).
  const guess = new Date(midnightLocalAsUtc - offset);
  const offsetAtMidnight = tzOffsetMs(guess, tz);
  return new Date(midnightLocalAsUtc - offsetAtMidnight);
}

export interface ResolvedRange {
  start: Date;
  end: Date;
  prevStart: Date;
  prevEnd: Date;
  /** نص الفترة السابقة للمقارنة. */
  prevLabel: string;
}

/**
 * اليوم = من بداية اليوم لهلأ، ويقارن بنفس المدة من أمس. أمس = يوم كامل ويقارن بقبله.
 * 7/30 يوم = آخر N يوم كاملة + اليوم الحالي، وتقارن بالفترة اللي قبلها بنفس الطول.
 */
export function resolveRange(range: TodayRange, now: Date, timeZone: string): ResolvedRange {
  const todayStart = startOfDayInZone(now, timeZone);
  switch (range) {
    case "today": {
      const elapsed = now.getTime() - todayStart.getTime();
      const prevStart = startOfDayInZone(new Date(todayStart.getTime() - 12 * 3_600_000), timeZone);
      return { start: todayStart, end: now, prevStart, prevEnd: new Date(prevStart.getTime() + elapsed), prevLabel: "عن أمس" };
    }
    case "yesterday": {
      const start = startOfDayInZone(new Date(todayStart.getTime() - 12 * 3_600_000), timeZone);
      const prevStart = startOfDayInZone(new Date(start.getTime() - 12 * 3_600_000), timeZone);
      return { start, end: todayStart, prevStart, prevEnd: start, prevLabel: "عن اليوم اللي قبله" };
    }
    default: {
      const days = range === "7d" ? 7 : 30;
      const start = new Date(todayStart.getTime() - (days - 1) * DAY);
      const span = now.getTime() - start.getTime();
      return { start, end: now, prevStart: new Date(start.getTime() - span), prevEnd: start, prevLabel: `عن الفترة اللي قبلها` };
    }
  }
}
