/**
 * Customer PII masking — سيستم 7: بيانات الزبون بتتقنّع قبل أي موديل خارجي.
 * The internal model on your server sees the full data; anything leaving the
 * server (external provider) gets masked phone/name/address first.
 */

const PHONE_RE = /(\+?\d[\d\s-]{7,}\d)/g;
const EMAIL_RE = /([\w.+-]+)@([\w-]+\.[\w.-]+)/g;

export interface MaskingMap {
  originals: string[];
  masked: string[];
}

function maskPhoneDigits(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.length < 6) return raw;
  const head = digits.slice(0, 4);
  return `${head}${"•".repeat(Math.max(digits.length - 6, 3))}${digits.slice(-2)}`;
}

function maskName(raw: string): string {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return raw;
  const masked = parts.map((p) => (p.length <= 1 ? p : `${p[0]}${"•".repeat(Math.max(p.length - 1, 2))}`));
  return masked.join(" ");
}

/**
 * Masks PII in text sent to external models. Returns the masked text and the
 * replacement map so the reply can be un-masked back for the local channel.
 */
export function maskCustomerPII(input: {
  text: string;
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
}): { masked: string; map: MaskingMap } {
  const originals: string[] = [];
  const maskedValues: string[] = [];
  let masked = input.text;

  const apply = (original: string, replacement: string) => {
    if (!original || originals.includes(original)) return;
    originals.push(original);
    maskedValues.push(replacement);
    masked = masked.split(original).join(replacement);
  };

  if (input.customerPhone) apply(input.customerPhone, maskPhoneDigits(input.customerPhone));
  if (input.customerName) apply(input.customerName, maskName(input.customerName));
  if (input.customerAddress) apply(input.customerAddress, "[عنوان مُقنَّع]");

  // Fallback: any phone-looking / email-looking sequence left in the text.
  masked = masked.replace(PHONE_RE, (m) => maskPhoneDigits(m));
  masked = masked.replace(EMAIL_RE, "[بريد مُقنَّع]");

  return { masked, map: { originals, masked: maskedValues } };
}

/** Restores masked values in an external model reply before sending to the customer. */
export function unmaskPII(text: string, map: MaskingMap): string {
  let out = text;
  map.originals.forEach((original, i) => {
    out = out.split(map.masked[i]).join(original);
  });
  return out;
}

/** True if the text still contains a full phone-like number (used in tests/gates). */
export function containsPhoneLike(text: string): boolean {
  const digitsOnly = text.replace(/[^\d]/g, "");
  return PHONE_RE.test(text) && digitsOnly.replace(/•/g, "").length >= 10;
}
