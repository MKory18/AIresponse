/**
 * Time range resolution for analytics.
 *
 * Timestamps are stored in UTC everywhere. Day boundaries are computed in the
 * workspace timezone (via Intl), then converted back to UTC instants, so a
 * "day" means the workspace's business day — not the browser's or UTC's.
 */

export type PresetRange = "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";

export interface ResolvedRange {
  start: Date;
  end: Date; // exclusive
}

/** Offset (minutes) of a timezone at a given instant, e.g. +180 for UTC+3. */
export function timezoneOffsetMinutes(timezone: string, instant: Date): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = dtf.formatToParts(instant).reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
    const asUTC = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour === "24" ? "0" : parts.hour), Number(parts.minute), Number(parts.second)
    );
    // Offsets are whole minutes in real zones — round to kill sub-minute drift.
    return Math.round((asUTC - instant.getTime()) / 60_000);
  } catch {
    return 0; // unknown timezone → UTC
  }
}

function startOfDayInTZ(timezone: string, dayOffset: number, base = new Date()): Date {
  const offset = timezoneOffsetMinutes(timezone, base);
  // Current "wall clock" as UTC-shifted instant, then floor to day.
  const shifted = new Date(base.getTime() + offset * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() + dayOffset);
  // Convert wall-clock midnight back to a real instant.
  const instant = new Date(shifted.getTime() - offset * 60_000);
  // Re-derive offset at the new instant (DST) and correct once.
  const offset2 = timezoneOffsetMinutes(timezone, instant);
  return new Date(shifted.getTime() - offset2 * 60_000);
}

export interface RangeQuery {
  range?: PresetRange;
  from?: string;
  to?: string;
  timezone?: string;
}

/** Server-side validated range. Custom ranges are clamped to 92 days. */
export function resolveRange(q: RangeQuery): ResolvedRange & { timezone: string } {
  const timezone = q.timezone ?? "UTC";
  const range = q.range ?? "last_7_days";

  if (range === "custom") {
    if (!q.from || !q.to) throw new Error("custom range requires from and to");
    const start = new Date(q.from);
    const end = new Date(q.to);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error("invalid dates");
    if (end.getTime() - start.getTime() > 92 * 24 * 3600_000) throw new Error("range too large (max 92 days)");
    return { start, end, timezone };
  }

  switch (range) {
    case "today":
      return { start: startOfDayInTZ(timezone, 0), end: startOfDayInTZ(timezone, 1), timezone };
    case "yesterday":
      return { start: startOfDayInTZ(timezone, -1), end: startOfDayInTZ(timezone, 0), timezone };
    case "last_7_days":
      return { start: startOfDayInTZ(timezone, -6), end: startOfDayInTZ(timezone, 1), timezone };
    case "last_30_days":
      return { start: startOfDayInTZ(timezone, -29), end: startOfDayInTZ(timezone, 1), timezone };
    default:
      return { start: startOfDayInTZ(timezone, -6), end: startOfDayInTZ(timezone, 1), timezone };
  }
}

/** List of UTC midnights covering [start, end) — used by daily aggregation. */
export function eachUtcDay(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  while (cur < end) {
    days.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
