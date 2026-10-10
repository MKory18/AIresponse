/**
 * P10 — جمع نقدي دقيق: القيم المالية Decimal(12,2) تُجمع بالسنتات (أعداد
 * صحيحة) لتفادي انجراف floating-point، وتُعاد كسعر عشري للعرض.
 * مدخل غير رقمي/ناقص يُتجاهل — لا يُحسب صفرًا مزورًا (الفارق: مجموع فارغ = null).
 */

export function sumMoneyCents(values: Array<string | number | null | undefined>): number {
  return values.reduce<number>((s, v) => {
    if (v === null || v === undefined) return s;
    const n = Number(v);
    if (Number.isNaN(n)) return s;
    return s + Math.round(n * 100);
  }, 0);
}

/** مجموع نقدي دقيق؛ null عند غياب أي قيمة (غياب بيانات ≠ صفر). */
export function sumMoney(values: Array<string | number | null | undefined>): number | null {
  let cents: number | null = null;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isNaN(n)) continue;
    cents = (cents ?? 0) + Math.round(n * 100);
  }
  return cents === null ? null : cents / 100;
}

/** متوسط قيمة الطلب = مجموع قيمه / عددها؛ null عند غياب المقام. */
export function avgMoney(values: Array<string | number | null | undefined>): number | null {
  let cents = 0;
  let count = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isNaN(n)) continue;
    cents += Math.round(n * 100);
    count += 1;
  }
  return count === 0 ? null : cents / count / 100;
}

/**
 * P10 — حارس حقن صيغ CSV (CSV Formula Injection): خلية نصية تبدأ بـ = + - @ أو
 * TAB/CR قد تُفسَّر كصيغة عند فتح الملف في Excel — تُسبق بعلامة اقتباس مفردة.
 */
export function csvEscapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`;
  return s;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (!rows.length) return "";
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (v: unknown) => {
    const cell = csvEscapeCell(v);
    return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  };
  const header = cols.join(",");
  const body = rows.map((r) => cols.map((c) => escape(r[c])).join(",")).join("\r\n");
  return `${header}\r\n${body}`;
}
