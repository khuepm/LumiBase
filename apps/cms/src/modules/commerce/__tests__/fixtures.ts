/**
 * Provider fixtures for #764 tests: Medusa v2 Admin API shapes, and Shopify
 * Admin GraphQL 2026-10 shapes (see shopify-schema-evidence.ts). Shopify
 * responses carry `X-Shopify-API-Version` like the real API.
 */

export const MEDUSA_PRODUCT = {
  id: 'prod_01',
  title: 'Trail Shoe',
  handle: 'trail-shoe',
  description: 'Grippy.',
  status: 'published',
  thumbnail: 'https://cdn.example/shoe.jpg',
  updated_at: '2026-11-19T08:00:00.000Z',
  variants: [
    {
      id: 'variant_01',
      title: 'EU 42',
      sku: 'TS-42',
      prices: [
        { amount: 120, currency_code: 'eur', min_quantity: null, max_quantity: 9 },
        { amount: 99.5, currency_code: 'eur', min_quantity: 10, max_quantity: null },
        { amount: 80, currency_code: 'eur', min_quantity: null, max_quantity: null, price_list_id: 'plist_vip' },
        { amount: 130, currency_code: 'usd', min_quantity: null, max_quantity: null },
      ],
    },
  ],
};

export const medusaProduct = (over: Record<string, unknown> = {}) => ({ ...MEDUSA_PRODUCT, ...over });

export const MEDUSA_PROMOTION = {
  id: 'promo_01',
  code: 'WINTER10',
  status: 'active',
  is_automatic: false,
  campaign: { name: 'Winter sale', starts_at: '2026-12-01T00:00:00.000Z', ends_at: '2027-01-31T00:00:00.000Z' },
  application_method: { type: 'percentage', value: 10, currency_code: null },
};

export const SHOPIFY_PRODUCT = {
  id: 'gid://shopify/Product/1001',
  title: 'Mug',
  handle: 'mug',
  description: 'Ceramic.',
  status: 'ACTIVE',
  updatedAt: '2026-11-19T08:00:00Z',
  featuredMedia: { preview: { image: { url: 'https://cdn.shopify.example/mug.png' } } },
  variants: { nodes: [{ id: 'gid://shopify/ProductVariant/2001', title: 'Default Title', sku: '', price: '12.50', compareAtPrice: '15.00' }] },
};

export const SHOPIFY_DISCOUNTS = {
  discountNodes: {
    nodes: [
      {
        id: 'gid://shopify/DiscountCodeNode/1',
        discount: {
          __typename: 'DiscountCodeBasic',
          title: 'Ten off',
          status: 'ACTIVE',
          startsAt: '2026-11-01T00:00:00Z',
          endsAt: null,
          codes: { nodes: [{ code: 'TEN' }] },
          customerGets: { value: { percentage: 0.1 } },
        },
      },
      { id: 'gid://shopify/DiscountCodeNode/2', discount: { __typename: 'DiscountCodeBxgy', title: 'BOGO', status: 'ACTIVE' } },
    ],
  },
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A Shopify Admin GraphQL response served by the pinned version. */
export const shopifyJson = (body: unknown, version = '2026-10') => json(body, 200, { 'X-Shopify-API-Version': version });
