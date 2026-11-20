/**
 * Shopify Admin GraphQL schema evidence for the pinned version (#764 review).
 *
 * Captured 2026-11-19 from the 2026-10 reference on shopify.dev (every page's
 * front matter reads `api_version: 2026-10`). For each type: the fields the
 * adapter relies on, with their documented type, and the deprecated fields the
 * adapter must not use. This is documentation evidence; the live contract
 * test (`shopify.contract.test.ts`) checks the same contract by introspecting a
 * real store.
 */
export const SHOPIFY_SCHEMA_EVIDENCE = {
  version: '2026-10',
  capturedAt: '2026-11-19',
  versioning: {
    source: 'https://shopify.dev/docs/api/usage/versioning',
    supported: ['2026-01', '2026-04', '2026-07', '2026-10'],
    latestStable: '2026-10',
    supportedUntil: { '2026-10': '2027-10-16T15:00:00Z' },
    note: 'Inaccessible versions fall forward; X-Shopify-API-Version names the version that served the request.',
  },
  types: {
    QueryRoot: { source: 'queries/shop, queries/products, queries/discountNodes', fields: { shop: 'Shop!', products: 'ProductConnection!', product: 'Product', discountNodes: 'DiscountNodeConnection!' } },
    Shop: { source: 'queries/shop', fields: { currencyCode: 'CurrencyCode!' } },
    ProductConnection: { source: 'queries/products', fields: { pageInfo: 'PageInfo!', nodes: '[Product!]!' } },
    PageInfo: { source: 'objects/PageInfo', fields: { hasNextPage: 'Boolean!', endCursor: 'String' } },
    Product: {
      source: 'objects/Product',
      fields: { id: 'ID!', title: 'String!', handle: 'String!', description: 'String!', status: 'ProductStatus!', updatedAt: 'DateTime!', featuredMedia: 'Media', variants: 'ProductVariantConnection!' },
      deprecated: ['featuredImage', 'bodyHtml'],
    },
    Media: { source: 'interfaces/Media', fields: { preview: 'MediaPreviewImage' } },
    MediaPreviewImage: { source: 'objects/MediaPreviewImage', fields: { image: 'Image' } },
    Image: { source: 'objects/Image', fields: { url: 'URL!' } },
    ProductVariantConnection: { source: 'objects/Product (variants)', fields: { nodes: '[ProductVariant!]!' } },
    ProductVariant: { source: 'objects/ProductVariant', fields: { id: 'ID!', title: 'String!', sku: 'String', price: 'Money!', compareAtPrice: 'Money' } },
    DiscountNodeConnection: { source: 'queries/discountNodes', fields: { nodes: '[DiscountNode!]!' } },
    DiscountNode: { source: 'queries/discountNodes', fields: { id: 'ID!', discount: 'Discount!' } },
    DiscountCodeBasic: {
      source: 'objects/DiscountCodeBasic',
      fields: { title: 'String!', status: 'DiscountStatus!', startsAt: 'DateTime!', endsAt: 'DateTime', codes: 'DiscountRedeemCodeConnection!', customerGets: 'DiscountCustomerGets!' },
      deprecated: ['customerSelection', 'discountClass'],
    },
    DiscountAutomaticBasic: {
      source: 'objects/DiscountAutomaticBasic',
      fields: { title: 'String!', status: 'DiscountStatus!', startsAt: 'DateTime!', endsAt: 'DateTime', customerGets: 'DiscountCustomerGets!' },
      deprecated: ['discountClass', 'usageCount'],
    },
    DiscountRedeemCodeConnection: { source: 'connections/DiscountRedeemCodeConnection', fields: { nodes: '[DiscountRedeemCode!]!' } },
    DiscountRedeemCode: { source: 'objects/DiscountRedeemCode', fields: { code: 'String!' } },
    DiscountCustomerGets: { source: 'objects/DiscountCustomerGets', fields: { value: 'DiscountCustomerGetsValue!' } },
    DiscountPercentage: { source: 'objects/DiscountPercentage; input-objects/DiscountCustomerGetsValueInput ("between 0.00 - 1.00")', fields: { percentage: 'Float!' } },
    DiscountAmount: { source: 'objects/DiscountAmount', fields: { amount: 'MoneyV2!' } },
    MoneyV2: { source: 'objects/DiscountAmount (MoneyV2)', fields: { amount: 'Decimal!', currencyCode: 'CurrencyCode!' } },
  },
  scalars: { Money: 'A monetary value string without a currency symbol or code, e.g. "100.57" (scalars/Money)' },
  unions: { DiscountCustomerGetsValue: ['DiscountAmount', 'DiscountOnQuantity', 'DiscountPercentage'] },
  webhooks: {
    source: 'apps/build/webhooks/verify-deliveries; api/webhooks (app config example, api_version 2026-10)',
    signature: 'X-Shopify-Hmac-Sha256: base64 HMAC-SHA256 of the raw body with the app client secret',
    topics: ['products/create', 'products/update', 'products/delete'],
    /** Not captured from the docs: the adapter accepts either key. */
    unverifiedPayloadKeys: ['admin_graphql_api_id', 'id'],
  },
} as const;
