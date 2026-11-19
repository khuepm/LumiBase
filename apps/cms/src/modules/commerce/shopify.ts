/**
 * Shopify adapter (#764): Admin GraphQL API with an app access token
 * (`X-Shopify-Access-Token`). Webhooks (`products/create|update|delete`) are
 * verified with `X-Shopify-Hmac-Sha256`, the base64 HMAC of the raw body with
 * the app's client secret.
 *
 * Variant prices carry `compareAtPrice`; Shopify quantity price breaks exist
 * only on B2B catalogs, so each variant has a single tier here.
 */
import { hmacBase64, timingSafeEqual } from './signature';
import {
  CommerceError,
  upstreamError,
  type CommerceAdapter,
  type CommerceProduct,
  type CommercePromotion,
  type FetchLike,
  type ProductPage,
  type WebhookIntent,
} from './types';

export const SHOPIFY_API_VERSION = '2025-01';
/** `<store>.myshopify.com` only: the adapter never calls an arbitrary host. */
export const SHOPIFY_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;

export interface ShopifyConfig {
  shopDomain: string;
  accessToken: string;
  /** App client secret, used to verify webhooks. */
  webhookSecret: string;
}

const PRODUCT_FIELDS = `id title handle description status updatedAt featuredImage { url }
  variants(first: 100) { nodes { id title sku price compareAtPrice } }`;

interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  description?: string | null;
  status?: string;
  updatedAt?: string | null;
  featuredImage?: { url?: string | null } | null;
  variants?: { nodes?: Array<{ id: string; title?: string | null; sku?: string | null; price?: string | null; compareAtPrice?: string | null }> };
}

export function mapShopifyProduct(p: ShopifyProduct, currency: string): CommerceProduct {
  return {
    externalId: p.id,
    title: p.title,
    handle: p.handle,
    description: p.description ?? null,
    published: p.status === 'ACTIVE',
    thumbnail: p.featuredImage?.url ?? null,
    updatedAt: p.updatedAt ?? null,
    variants: (p.variants?.nodes ?? []).map((v) => ({
      externalId: v.id,
      title: v.title ?? '',
      sku: v.sku || null,
      prices:
        v.price === null || v.price === undefined
          ? []
          : [
              {
                currency,
                amount: Number(v.price),
                minQuantity: null,
                maxQuantity: null,
                compareAt: v.compareAtPrice ? Number(v.compareAtPrice) : null,
              },
            ],
    })),
  };
}

interface ShopifyDiscount {
  __typename?: string;
  title?: string;
  status?: string;
  startsAt?: string | null;
  endsAt?: string | null;
  codes?: { nodes?: Array<{ code: string }> };
  customerGets?: { value?: { percentage?: number; amount?: { amount?: string; currencyCode?: string } } };
}

export function mapShopifyDiscount(id: string, d: ShopifyDiscount): CommercePromotion {
  const value = d.customerGets?.value ?? {};
  const pct = typeof value.percentage === 'number';
  return {
    externalId: id,
    title: d.title ?? id,
    code: d.codes?.nodes?.[0]?.code ?? null,
    kind: pct ? 'percentage' : 'fixed',
    // Shopify reports 0.1 for 10 %.
    value: pct ? Math.round(value.percentage! * 10_000) / 100 : Number(value.amount?.amount ?? 0),
    currency: pct ? null : (value.amount?.currencyCode ?? null),
    active: d.status === 'ACTIVE',
    startsAt: d.startsAt ?? null,
    endsAt: d.endsAt ?? null,
  };
}

const DISCOUNT_FIELDS = `title status startsAt endsAt
  customerGets { value { ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } } } }`;

export class ShopifyAdapter implements CommerceAdapter {
  readonly name = 'shopify' as const;
  private currency: string | null = null;

  constructor(
    private readonly config: ShopifyConfig,
    private readonly fetchImpl: FetchLike,
  ) {
    if (!SHOPIFY_DOMAIN_RE.test(config.shopDomain)) {
      throw new CommerceError('COMMERCE_CONFIG_INVALID', 'shopDomain must be <store>.myshopify.com.', 400);
    }
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(`https://${this.config.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': this.config.accessToken },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw upstreamError('shopify', res.status);
    const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> };
    if (body.errors?.length) {
      if (body.errors.some((e) => e.extensions?.code === 'THROTTLED')) throw upstreamError('shopify', 429);
      throw new CommerceError('COMMERCE_UNAVAILABLE', `shopify: ${body.errors[0]?.message ?? 'GraphQL error'}`, 502);
    }
    return body.data as T;
  }

  private async shopCurrency(): Promise<string> {
    if (!this.currency) {
      const data = await this.gql<{ shop: { currencyCode: string } }>('{ shop { currencyCode } }');
      this.currency = data.shop.currencyCode;
    }
    return this.currency;
  }

  async listProducts(cursor: string | null): Promise<ProductPage> {
    const currency = await this.shopCurrency();
    const data = await this.gql<{ products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyProduct[] } }>(
      `query($after: String) { products(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS} } } }`,
      { after: cursor },
    );
    return {
      products: data.products.nodes.map((p) => mapShopifyProduct(p, currency)),
      next: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null,
    };
  }

  async getProduct(externalId: string): Promise<CommerceProduct | null> {
    const currency = await this.shopCurrency();
    const data = await this.gql<{ product: ShopifyProduct | null }>(`query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`, { id: externalId });
    return data.product ? mapShopifyProduct(data.product, currency) : null;
  }

  async listPromotions(): Promise<CommercePromotion[]> {
    const data = await this.gql<{ discountNodes: { nodes: Array<{ id: string; discount: ShopifyDiscount }> } }>(
      `{ discountNodes(first: 100) { nodes { id discount { __typename
          ... on DiscountCodeBasic { ${DISCOUNT_FIELDS} codes(first: 1) { nodes { code } } }
          ... on DiscountAutomaticBasic { ${DISCOUNT_FIELDS} } } } } }`,
    );
    return data.discountNodes.nodes
      .filter((n) => n.discount.__typename === 'DiscountCodeBasic' || n.discount.__typename === 'DiscountAutomaticBasic')
      .map((n) => mapShopifyDiscount(n.id, n.discount));
  }

  async verifyWebhook(rawBody: string, headers: Headers): Promise<boolean> {
    const got = headers.get('x-shopify-hmac-sha256') ?? '';
    if (!got || !this.config.webhookSecret) return false;
    return timingSafeEqual(got, await hmacBase64(this.config.webhookSecret, rawBody));
  }

  parseWebhook(rawBody: string, headers: Headers): WebhookIntent {
    const topic = headers.get('x-shopify-topic') ?? '';
    let body: { id?: unknown; admin_graphql_api_id?: unknown };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      return { kind: 'ignore', reason: 'body is not JSON' };
    }
    const m = /^products\/(create|update|delete)$/.exec(topic);
    if (!m) return { kind: 'ignore', reason: `unsupported topic "${topic}"` };
    const gid =
      typeof body.admin_graphql_api_id === 'string'
        ? body.admin_graphql_api_id
        : typeof body.id === 'number' || typeof body.id === 'string'
          ? `gid://shopify/Product/${body.id}`
          : '';
    if (!gid) return { kind: 'ignore', reason: 'no product id' };
    return { kind: 'product', action: m[1] === 'delete' ? 'delete' : 'upsert', externalId: gid };
  }
}
