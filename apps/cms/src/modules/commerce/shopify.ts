/**
 * Shopify adapter (#764): Admin GraphQL API with an app access token
 * (`X-Shopify-Access-Token`). Webhooks (`products/create|update|delete`) are
 * verified with `X-Shopify-Hmac-Sha256`, the base64 HMAC of the raw body with
 * the app's client secret.
 *
 * Variant prices carry `compareAtPrice`; Shopify quantity price breaks exist
 * only on B2B catalogs, so each variant has a single tier here.
 *
 * API version. Shopify releases a version each quarter and supports each for
 * at least 12 months; a request for a retired version is silently served by an
 * older-or-newer accessible one ("fall forward"), so the schema these queries
 * were written against is no longer what answers. The adapter therefore:
 * - pins {@link SHOPIFY_API_VERSION} (a currently supported stable version),
 *   with its end of support in {@link SHOPIFY_API_VERSION_SUPPORTED_UNTIL};
 *   a unit test fails 90 days before that date so the pin is renewed in time;
 * - refuses a response whose `X-Shopify-API-Version` differs from the pin
 *   (`COMMERCE_API_VERSION_MISMATCH`) instead of trusting a fallback schema;
 * - selects only the fields listed in {@link SHOPIFY_CONTRACT}, which the
 *   captured-schema test and the live contract test check against Shopify.
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

export const SHOPIFY_API_VERSION = '2026-10';
/** End of support for the pinned version, from shopify.dev/docs/api/usage/versioning. */
export const SHOPIFY_API_VERSION_SUPPORTED_UNTIL = '2027-10-16T15:00:00Z';

/**
 * Every Admin GraphQL field the adapter selects, by type. The queries below
 * use exactly these; `shopify-schema.test.ts` checks them against the schema
 * captured from the 2026-10 reference, and `shopify.contract.test.ts`
 * introspects a real store (none may be missing or deprecated).
 */
export const SHOPIFY_CONTRACT = {
  QueryRoot: ['shop', 'products', 'product', 'discountNodes'],
  Shop: ['currencyCode'],
  ProductConnection: ['pageInfo', 'nodes'],
  PageInfo: ['hasNextPage', 'endCursor'],
  Product: ['id', 'title', 'handle', 'description', 'status', 'updatedAt', 'featuredMedia', 'variants'],
  Media: ['preview'],
  MediaPreviewImage: ['image'],
  Image: ['url'],
  ProductVariantConnection: ['nodes'],
  ProductVariant: ['id', 'title', 'sku', 'price', 'compareAtPrice'],
  DiscountNodeConnection: ['nodes'],
  DiscountNode: ['id', 'discount'],
  DiscountCodeBasic: ['title', 'status', 'startsAt', 'endsAt', 'codes', 'customerGets'],
  DiscountAutomaticBasic: ['title', 'status', 'startsAt', 'endsAt', 'customerGets'],
  DiscountRedeemCodeConnection: ['nodes'],
  DiscountRedeemCode: ['code'],
  DiscountCustomerGets: ['value'],
  DiscountPercentage: ['percentage'],
  DiscountAmount: ['amount'],
  MoneyV2: ['amount', 'currencyCode'],
} as const;
/** `<store>.myshopify.com` only: the adapter never calls an arbitrary host. */
export const SHOPIFY_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;

export interface ShopifyConfig {
  shopDomain: string;
  accessToken: string;
  /** App client secret, used to verify webhooks. */
  webhookSecret: string;
}

// `featuredImage` is deprecated in 2026-10; the featured media's preview image replaces it.
const PRODUCT_FIELDS = `id title handle description status updatedAt featuredMedia { preview { image { url } } }
  variants(first: 100) { nodes { id title sku price compareAtPrice } }`;

interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  description?: string | null;
  status?: string;
  updatedAt?: string | null;
  featuredMedia?: { preview?: { image?: { url?: string | null } | null } | null } | null;
  variants?: { nodes?: Array<{ id: string; title?: string | null; sku?: string | null; price?: string | null; compareAtPrice?: string | null }> };
}

export function mapShopifyProduct(p: ShopifyProduct, currency: string): CommerceProduct {
  return {
    externalId: p.id,
    title: p.title,
    handle: p.handle,
    description: p.description ?? null,
    published: p.status === 'ACTIVE',
    thumbnail: p.featuredMedia?.preview?.image?.url ?? null,
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
    // `percentage` is 0.00–1.00 (0.1 = 10 %; DiscountCustomerGetsValueInput, 2026-10).
    value: pct ? Math.round(value.percentage! * 10_000) / 100 : Number(value.amount?.amount ?? 0),
    currency: pct ? null : (value.amount?.currencyCode ?? null),
    active: d.status === 'ACTIVE',
    startsAt: d.startsAt ?? null,
    endsAt: d.endsAt ?? null,
  };
}

const DISCOUNT_FIELDS = `title status startsAt endsAt
  customerGets { value { ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } } } }`;

/** Every query the adapter sends; checked against SHOPIFY_CONTRACT in tests. */
export const SHOPIFY_QUERIES = {
  shop: '{ shop { currencyCode } }',
  products: `query($after: String) { products(first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${PRODUCT_FIELDS} } } }`,
  product: `query($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`,
  discounts: `{ discountNodes(first: 100) { nodes { id discount { __typename
          ... on DiscountCodeBasic { ${DISCOUNT_FIELDS} codes(first: 1) { nodes { code } } }
          ... on DiscountAutomaticBasic { ${DISCOUNT_FIELDS} } } } } }`,
} as const;

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
    const served = res.headers.get('x-shopify-api-version');
    if (served && served !== SHOPIFY_API_VERSION) {
      throw new CommerceError(
        'COMMERCE_API_VERSION_MISMATCH',
        `shopify served API version ${served}, not the pinned ${SHOPIFY_API_VERSION}: the pinned version is no longer accessible. Upgrade LumiBase.`,
        502,
      );
    }
    const body = (await res.json()) as { data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> };
    if (body.errors?.length) {
      if (body.errors.some((e) => e.extensions?.code === 'THROTTLED')) throw upstreamError('shopify', 429);
      throw new CommerceError('COMMERCE_UNAVAILABLE', `shopify: ${body.errors[0]?.message ?? 'GraphQL error'}`, 502);
    }
    return body.data as T;
  }

  private async shopCurrency(): Promise<string> {
    if (!this.currency) {
      const data = await this.gql<{ shop: { currencyCode: string } }>(SHOPIFY_QUERIES.shop);
      this.currency = data.shop.currencyCode;
    }
    return this.currency;
  }

  async listProducts(cursor: string | null): Promise<ProductPage> {
    const currency = await this.shopCurrency();
    const data = await this.gql<{ products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ShopifyProduct[] } }>(
      SHOPIFY_QUERIES.products,
      { after: cursor },
    );
    return {
      products: data.products.nodes.map((p) => mapShopifyProduct(p, currency)),
      next: data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null,
    };
  }

  async getProduct(externalId: string): Promise<CommerceProduct | null> {
    const currency = await this.shopCurrency();
    const data = await this.gql<{ product: ShopifyProduct | null }>(SHOPIFY_QUERIES.product, { id: externalId });
    return data.product ? mapShopifyProduct(data.product, currency) : null;
  }

  async listPromotions(): Promise<CommercePromotion[]> {
    const data = await this.gql<{ discountNodes: { nodes: Array<{ id: string; discount: ShopifyDiscount }> } }>(
      SHOPIFY_QUERIES.discounts,
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
