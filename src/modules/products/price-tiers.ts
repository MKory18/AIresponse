const WHOLESALE_LABEL = /جمل[ةه]|موزّ?ع|wholesale|distributor|dealer/i;

export function isWholesaleTier(tier: { label: string }): boolean {
  return WHOLESALE_LABEL.test(tier.label);
}

/** Named prices that may be quoted to a retail customer. */
export function customerFacingPriceTiers<T extends { label: string }>(tiers: T[]): T[] {
  return tiers.filter((tier) => !isWholesaleTier(tier));
}
