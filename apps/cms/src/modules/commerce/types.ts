/**
 * Commerce content adapters (#764): the normalised shapes every provider maps
 * to, and the port the sync talks to. LumiBase only mirrors catalogue content
 * (products, variants, prices, promotions) for display; there is no cart or
 * checkout here.
 */

export type CommerceProviderName = 'medusa' | 'shopify';
export const COMMERCE_PROVIDERS: readonly CommerceProviderName[] = ['medusa', 'shopify'];

/** One price of a variant. `minQuantity` / `maxQuantity` make it a tier. */
export interface PriceTier {
  currency: string;
  /** Major units (12.5 = 12.50). */
  amount: number;
  minQuantity: number | null;
  maxQuantity: number | null;
  /** Shopify `compareAtPrice`: the struck-through price, when on sale. */
  compareAt?: number | null;
}

export interface CommerceVariant {
  externalId: string;
  title: string;
  sku: string | null;
  prices: PriceTier[];
}

export interface CommerceProduct {
  externalId: string;
  title: string;
  handle: string;
  description: string | null;
  /** Provider status mapped to LumiBase: `published` for active / live products. */
  published: boolean;
  thumbnail: string | null;
  variants: CommerceVariant[];
  updatedAt: string | null;
}

export interface CommercePromotion {
  externalId: string;
  title: string;
  /** Discount code; null for automatic promotions. */
  code: string | null;
  kind: 'percentage' | 'fixed';
  /** Percent (10 = 10 %) or an amount in major units. */
  value: number;
  currency: string | null;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
}

export interface ProductPage {
  products: CommerceProduct[];
  /** Opaque cursor for the next page; null at the end. */
  next: string | null;
}

/** What a verified webhook asks the sync to do. The body is never trusted as data. */
export type WebhookIntent =
  | { kind: 'product'; action: 'upsert' | 'delete'; externalId: string }
  | { kind: 'promotion'; action: 'upsert' | 'delete'; externalId: string }
  | { kind: 'ignore'; reason: string };

export interface CommerceAdapter {
  readonly name: CommerceProviderName;
  listProducts(cursor: string | null): Promise<ProductPage>;
  /** null when the product no longer exists. */
  getProduct(externalId: string): Promise<CommerceProduct | null>;
  listPromotions(): Promise<CommercePromotion[]>;
  /** Verify the signature over the raw body; false for a missing or wrong signature. */
  verifyWebhook(rawBody: string, headers: Headers): Promise<boolean>;
  parseWebhook(rawBody: string, headers: Headers): WebhookIntent;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class CommerceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 404 | 422 | 429 | 502 | 503 = 502,
  ) {
    super(message);
    this.name = 'CommerceError';
  }
}

/** Map an upstream HTTP failure to a CommerceError. */
export function upstreamError(provider: CommerceProviderName, status: number): CommerceError {
  if (status === 401 || status === 403) return new CommerceError('COMMERCE_CREDENTIALS_REJECTED', `${provider} rejected the credentials.`, 422);
  if (status === 404) return new CommerceError('COMMERCE_NOT_FOUND', `${provider} answered 404.`, 404);
  if (status === 429) return new CommerceError('COMMERCE_RATE_LIMITED', `${provider} is rate-limiting requests.`, 429);
  return new CommerceError('COMMERCE_UNAVAILABLE', `${provider} answered ${status}.`, 502);
}

/** Lowest price of a product in a currency (tier-aware: the cheapest tier counts). */
export function priceFrom(product: CommerceProduct): { amount: number; currency: string } | null {
  let best: { amount: number; currency: string } | null = null;
  for (const v of product.variants) {
    for (const p of v.prices) {
      if (!best || (p.currency === best.currency && p.amount < best.amount)) best = { amount: p.amount, currency: p.currency };
    }
  }
  return best;
}
