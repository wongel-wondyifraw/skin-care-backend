/**
 * Shared pricing helpers for list price vs sale price.
 */
export function clampDiscountPercent(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}

export function effectiveUnitPrice(
  listPrice: number,
  discountPercent: unknown,
): number {
  const price = Number(listPrice) || 0;
  const pct = clampDiscountPercent(discountPercent);
  if (pct <= 0) return Math.round(price * 100) / 100;
  const sale = price * (1 - pct / 100);
  return Math.round(sale * 100) / 100;
}
