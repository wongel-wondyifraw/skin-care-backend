/**
 * Shared pricing helpers for list price vs sale price.
 */

export function clampDiscountPercent(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}

export function isDiscountExpired(discountEndsAt: unknown, now = Date.now()): boolean {
  if (discountEndsAt == null || discountEndsAt === '') return false;
  const end = new Date(discountEndsAt as string | Date).getTime();
  if (!Number.isFinite(end)) return false;
  return end <= now;
}

/** Active % after applying expiry (0 if expired or none). */
export function activeDiscountPercent(
  discountPercent: unknown,
  discountEndsAt?: unknown,
  now = Date.now(),
): number {
  if (isDiscountExpired(discountEndsAt, now)) return 0;
  return clampDiscountPercent(discountPercent);
}

export function effectiveUnitPrice(
  listPrice: number,
  discountPercent: unknown,
  discountEndsAt?: unknown,
): number {
  const price = Number(listPrice) || 0;
  const pct = activeDiscountPercent(discountPercent, discountEndsAt);
  if (pct <= 0) return Math.round(price * 100) / 100;
  const sale = price * (1 - pct / 100);
  return Math.round(sale * 100) / 100;
}
