import { timezoneOffsetMinutes } from "@/core/analytics/time";
import { AppError } from "@/core/errors";

/**
 * P12 — المدخلات الموحّدة للفترات بباب الوكلاء (عقد agent-door/v1 §6):
 * today · yesterday · last_7d · last_week · last_30d · last_month · month_to_date
 * أو from/to بتاريخ ISO. كل الحدود بمنطقة مساحة العمل (يوم العمل لا يوم UTC).
 *
 * last_week = الأيام السبعة التي قبل last_7d (لا أسبوع تقويمي — بدايته تختلف
 * بين الأسواق) — تعريف ثابت ومكتوب.
 */

export const PERIODS = ["today", "yesterday", "last_7d", "last_week", "last_30d", "last_month", "month_to_date"] as const;
export type Period = (typeof PERIODS)[number];

export interface ResolvedPeriod {
  start: Date;
  end: Date;
  label: string;
}

function wallMidnight(now: Date, tz: string, dayOffset: number): Date {
  const offset = timezoneOffsetMinutes(tz, now);
  const shifted = new Date(now.getTime() + offset * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() + dayOffset);
  const guess = new Date(shifted.getTime() - offset * 60_000);
  const offset2 = timezoneOffsetMinutes(tz, guess);
  return new Date(shifted.getTime() - offset2 * 60_000);
}

function monthStart(now: Date, tz: string, monthOffset: number): Date {
  const offset = timezoneOffsetMinutes(tz, now);
  const shifted = new Date(now.getTime() + offset * 60_000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + monthOffset;
  const wall = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  const off = timezoneOffsetMinutes(tz, wall);
  return new Date(wall.getTime() - off * 60_000);
}

/**
 * تاريخ من مدخل وكيل: يوم صافٍ (2026-10-01) = منتصف ليل ذاك اليوم بمنطقة
 * مساحة العمل («to» بيوم صافٍ = شامل لآخر اليوم)؛ وقت بلا منطقة = وقت جداري
 * بمنطقة مساحة العمل (مش منطقة السيرفر)؛ وقت بمنطقة = كما هو.
 */
export function parseAgentDate(raw: string, tz: string, inclusiveEnd = false): Date {
  const s = raw.trim();
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const wall = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (dateOnly || wall) {
    const m = (dateOnly ?? wall)!;
    const utcWall = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]) + (dateOnly && inclusiveEnd ? 1 : 0),
      wall ? Number(m[4]) : 0,
      wall ? Number(m[5]) : 0,
      wall && m[6] ? Number(m[6]) : 0,
      wall && m[7] ? Number(m[7].padEnd(3, "0")) : 0
    );
    if (Number.isNaN(utcWall)) return new Date(NaN);
    const off1 = timezoneOffsetMinutes(tz, new Date(utcWall));
    const guess = utcWall - off1 * 60_000;
    const off2 = timezoneOffsetMinutes(tz, new Date(guess));
    return new Date(utcWall - off2 * 60_000);
  }
  return new Date(s);
}

export function resolvePeriod(input: { period?: string | null; from?: string | null; to?: string | null }, tz: string, now = new Date()): ResolvedPeriod {
  if (input.from || input.to) {
    if (!input.from || !input.to) throw new AppError("from و to مع بعض", 422, "VALIDATION_FAILED");
    const start = parseAgentDate(input.from, tz);
    const end = parseAgentDate(input.to, tz, true);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new AppError("فترة غير صالحة", 422, "VALIDATION_FAILED");
    }
    if (end.getTime() - start.getTime() > 92 * 24 * 3600_000) throw new AppError("أقصى فترة 92 يوم", 422, "VALIDATION_FAILED");
    return { start, end, label: "custom" };
  }
  const p = (input.period ?? "yesterday") as Period;
  switch (p) {
    case "today":
      return { start: wallMidnight(now, tz, 0), end: wallMidnight(now, tz, 1), label: p };
    case "yesterday":
      return { start: wallMidnight(now, tz, -1), end: wallMidnight(now, tz, 0), label: p };
    case "last_7d":
      return { start: wallMidnight(now, tz, -6), end: wallMidnight(now, tz, 1), label: p };
    case "last_week":
      return { start: wallMidnight(now, tz, -13), end: wallMidnight(now, tz, -6), label: p };
    case "last_30d":
      return { start: wallMidnight(now, tz, -29), end: wallMidnight(now, tz, 1), label: p };
    case "last_month":
      return { start: monthStart(now, tz, -1), end: monthStart(now, tz, 0), label: p };
    case "month_to_date":
      return { start: monthStart(now, tz, 0), end: wallMidnight(now, tz, 1), label: p };
    default:
      throw new AppError(`فترة غير معروفة: ${String(p)}`, 422, "VALIDATION_FAILED");
  }
}
