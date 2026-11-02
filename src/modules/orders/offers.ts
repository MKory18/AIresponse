import { productOfferSchema, type ProductOffer } from "@/modules/sales/plan-schemas";

/**
 * Product offers/packages are stored on `Product.offers` (synced from the OMS).
 * The order line's `quantity` is the number of PACKAGES the customer wants —
 * never the number of pieces inside a package. The package price/title always
 * come from this DB row at confirmation time; the model never supplies money.
 */

export type ResolvedOffer =
  | { status: "none" }
  | { status: "resolved"; offer: ProductOffer }
  | { status: "not_found" }
  | { status: "ambiguous"; candidates: ProductOffer[] };

/** Normalizes Arabic/Latin labels for a tolerant, deterministic comparison. */
export function normalizeOfferLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function activeOffers(raw: unknown, now = new Date()): ProductOffer[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductOffer[] = [];
  for (const row of raw) {
    const parsed = productOfferSchema.safeParse(row);
    if (!parsed.success) continue;
    if (parsed.data.expiresAt && new Date(parsed.data.expiresAt).getTime() <= now.getTime()) continue;
    out.push(parsed.data);
  }
  return out;
}

/**
 * Matches the customer's requested offer label against the DB offers.
 * No requested label → `none` (base product price). A requested label that
 * matches nothing/several rows is surfaced — we never guess a price.
 */
export function resolveOffer(rawOffers: unknown, requestedLabel?: string | null, now = new Date()): ResolvedOffer {
  const requested = requestedLabel?.trim();
  if (!requested) return { status: "none" };
  const offers = activeOffers(rawOffers, now);
  const wanted = normalizeOfferLabel(requested);
  if (!wanted) return { status: "none" };
  const exact = offers.filter((o) => normalizeOfferLabel(o.title) === wanted);
  if (exact.length === 1) return { status: "resolved", offer: exact[0]! };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact };
  // Tolerant containment both ways, but only when exactly one offer matches.
  const loose = offers.filter((o) => {
    const label = normalizeOfferLabel(o.title);
    return label.includes(wanted) || wanted.includes(label);
  });
  if (loose.length === 1) return { status: "resolved", offer: loose[0]! };
  if (loose.length > 1) return { status: "ambiguous", candidates: loose };
  return { status: "not_found" };
}

/** Price for an offer row is the package total; quantity stays packages. */
export function offerUnitPrice(offer: ProductOffer): number {
  return offer.price;
}
