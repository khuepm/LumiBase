/**
 * Rendering helpers for synced commerce products (#764).
 *
 * LumiBase mirrors Medusa / Shopify products into `commerce_products`; each
 * variant carries `prices`, and a price with `minQuantity` / `maxQuantity` is a
 * quantity tier. These helpers turn that into what a product card shows.
 */

export interface CommercePrice {
  currency: string;
  amount: number;
  minQuantity: number | null;
  maxQuantity: number | null;
  compareAt?: number | null;
}

export interface CommerceVariantLike {
  prices: CommercePrice[];
}

export interface PriceTierRow {
  /** Inclusive quantity range; `max` null means "and more". */
  min: number;
  max: number | null;
  amount: number;
  compareAt: number | null;
  /** e.g. `1–9`, `10+`. */
  label: string;
}

/**
 * The tiers of one variant in one currency, sorted by quantity. A variant
 * with a single price yields one row `1+`. When two prices cover the same
 * quantity, the lower one wins (what the provider would charge).
 */
export function priceTiers(variant: CommerceVariantLike, currency: string): PriceTierRow[] {
  const cur = currency.toUpperCase();
  const rows = variant.prices
    .filter((p) => p.currency.toUpperCase() === cur && Number.isFinite(p.amount))
    .map((p) => ({ min: Math.max(1, p.minQuantity ?? 1), max: p.maxQuantity ?? null, amount: p.amount, compareAt: p.compareAt ?? null }))
    .sort((a, b) => a.min - b.min || a.amount - b.amount);
  const out: PriceTierRow[] = [];
  for (const r of rows) {
    if (out.some((o) => o.min === r.min)) continue;
    out.push({ ...r, label: '' });
  }
  for (let i = 0; i < out.length; i += 1) {
    const next = out[i + 1];
    // Close an open-ended tier where the next one starts.
    if (next && (out[i]!.max === null || out[i]!.max! >= next.min)) out[i]!.max = next.min - 1;
    out[i]!.label = out[i]!.max === null ? `${out[i]!.min}+` : out[i]!.min === out[i]!.max ? `${out[i]!.min}` : `${out[i]!.min}–${out[i]!.max}`;
  }
  return out;
}

/** The unit price for a quantity, or null when no tier covers it. */
export function unitPrice(variant: CommerceVariantLike, currency: string, quantity: number): number | null {
  const tier = priceTiers(variant, currency).find((t) => quantity >= t.min && (t.max === null || quantity <= t.max));
  return tier?.amount ?? null;
}

/** `["1–9: $10.00", "10+: $8.00"]` with `Intl.NumberFormat`. */
export function formatPriceTiers(variant: CommerceVariantLike, currency: string, locale = 'en'): string[] {
  const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() });
  return priceTiers(variant, currency).map((t) => `${t.label}: ${fmt.format(t.amount)}`);
}
