/**
 * Medusa v2 adapter (#764): Admin REST API with a secret API key
 * (`Authorization: Basic base64(<key>:)`). Prices are v2 decimals (major
 * units); a price's `min_quantity` / `max_quantity` make it a tier.
 *
 * Medusa has no built-in outbound webhooks: a small subscriber in the Medusa
 * app posts `{ event, data: { id } }` signed with
 * `X-Lumi-Signature: sha256=<hex HMAC of the body>` (see the docs).
 */
import { hmacHex, timingSafeEqual } from './signature';
import {
  upstreamError,
  type CommerceAdapter,
  type CommerceProduct,
  type CommercePromotion,
  type FetchLike,
  type ProductPage,
  type WebhookIntent,
} from './types';

export interface MedusaConfig {
  /** Medusa backend origin, e.g. `https://shop-api.example.com`. */
  apiUrl: string;
  apiKey: string;
  webhookSecret: string;
}

const PRODUCT_FIELDS = 'id,title,handle,description,status,thumbnail,updated_at,*variants,*variants.prices';
const PAGE = 50;

interface MedusaPrice {
  amount?: number | string;
  currency_code?: string;
  min_quantity?: number | null;
  max_quantity?: number | null;
  price_list_id?: string | null;
}
interface MedusaVariant {
  id: string;
  title?: string | null;
  sku?: string | null;
  prices?: MedusaPrice[];
}
interface MedusaProduct {
  id: string;
  title?: string;
  handle?: string;
  description?: string | null;
  status?: string;
  thumbnail?: string | null;
  updated_at?: string | null;
  variants?: MedusaVariant[];
}

export function mapMedusaProduct(p: MedusaProduct): CommerceProduct {
  return {
    externalId: p.id,
    title: p.title ?? p.handle ?? p.id,
    handle: p.handle ?? p.id,
    description: p.description ?? null,
    published: p.status === 'published',
    thumbnail: p.thumbnail ?? null,
    updatedAt: p.updated_at ?? null,
    variants: (p.variants ?? []).map((v) => ({
      externalId: v.id,
      title: v.title ?? '',
      sku: v.sku ?? null,
      prices: (v.prices ?? [])
        // Price-list prices are customer-group specific; the base prices (and their tiers) are public.
        .filter((pr) => !pr.price_list_id && pr.amount !== undefined && pr.currency_code)
        .map((pr) => ({
          currency: String(pr.currency_code).toUpperCase(),
          amount: Number(pr.amount),
          minQuantity: pr.min_quantity ?? null,
          maxQuantity: pr.max_quantity ?? null,
        })),
    })),
  };
}

interface MedusaPromotion {
  id: string;
  code?: string | null;
  status?: string;
  is_automatic?: boolean;
  campaign?: { name?: string | null; starts_at?: string | null; ends_at?: string | null } | null;
  application_method?: { type?: string; value?: number | string; currency_code?: string | null } | null;
}

export function mapMedusaPromotion(p: MedusaPromotion): CommercePromotion {
  const am = p.application_method ?? {};
  return {
    externalId: p.id,
    title: p.campaign?.name ?? p.code ?? p.id,
    code: p.is_automatic ? null : (p.code ?? null),
    kind: am.type === 'percentage' ? 'percentage' : 'fixed',
    value: Number(am.value ?? 0),
    currency: am.currency_code ? am.currency_code.toUpperCase() : null,
    active: p.status === 'active',
    startsAt: p.campaign?.starts_at ?? null,
    endsAt: p.campaign?.ends_at ?? null,
  };
}

export class MedusaAdapter implements CommerceAdapter {
  readonly name = 'medusa' as const;
  private readonly base: string;

  constructor(
    private readonly config: MedusaConfig,
    private readonly fetchImpl: FetchLike,
  ) {
    this.base = config.apiUrl.replace(/\/+$/, '');
  }

  private async get<T>(path: string): Promise<T | null> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      headers: { Authorization: `Basic ${btoa(`${this.config.apiKey}:`)}`, Accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw upstreamError('medusa', res.status);
    return (await res.json()) as T;
  }

  async listProducts(cursor: string | null): Promise<ProductPage> {
    const offset = cursor ? Number(cursor) : 0;
    const body = await this.get<{ products: MedusaProduct[]; count?: number }>(
      `/admin/products?limit=${PAGE}&offset=${offset}&fields=${encodeURIComponent(PRODUCT_FIELDS)}`,
    );
    const products = (body?.products ?? []).map(mapMedusaProduct);
    const count = body?.count ?? offset + products.length;
    const nextOffset = offset + products.length;
    return { products, next: products.length > 0 && nextOffset < count ? String(nextOffset) : null };
  }

  async getProduct(externalId: string): Promise<CommerceProduct | null> {
    const body = await this.get<{ product: MedusaProduct }>(
      `/admin/products/${encodeURIComponent(externalId)}?fields=${encodeURIComponent(PRODUCT_FIELDS)}`,
    );
    return body?.product ? mapMedusaProduct(body.product) : null;
  }

  async listPromotions(): Promise<CommercePromotion[]> {
    const out: CommercePromotion[] = [];
    for (let offset = 0; offset < 10_000; offset += PAGE) {
      const body = await this.get<{ promotions: MedusaPromotion[]; count?: number }>(
        `/admin/promotions?limit=${PAGE}&offset=${offset}&fields=${encodeURIComponent('id,code,status,is_automatic,*campaign,*application_method')}`,
      );
      const page = body?.promotions ?? [];
      out.push(...page.map(mapMedusaPromotion));
      if (page.length < PAGE || out.length >= (body?.count ?? 0)) break;
    }
    return out;
  }

  async verifyWebhook(rawBody: string, headers: Headers): Promise<boolean> {
    const got = headers.get('x-lumi-signature')?.replace(/^sha256=/, '') ?? '';
    if (!got || !this.config.webhookSecret) return false;
    return timingSafeEqual(got.toLowerCase(), await hmacHex(this.config.webhookSecret, rawBody));
  }

  parseWebhook(rawBody: string): WebhookIntent {
    let body: { event?: unknown; data?: { id?: unknown } };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      return { kind: 'ignore', reason: 'body is not JSON' };
    }
    const event = typeof body.event === 'string' ? body.event : '';
    const id = typeof body.data?.id === 'string' ? body.data.id : '';
    const m = /^(product|promotion)\.(created|updated|deleted)$/.exec(event);
    if (!m || !id) return { kind: 'ignore', reason: `unsupported event "${event}"` };
    return { kind: m[1] as 'product' | 'promotion', action: m[2] === 'deleted' ? 'delete' : 'upsert', externalId: id };
  }
}
