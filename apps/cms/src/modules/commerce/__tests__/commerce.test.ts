import { describe, expect, it, vi } from 'vitest';
import { MedusaAdapter, mapMedusaProduct } from '../medusa';
import { ShopifyAdapter } from '../shopify';
import { hmacBase64, hmacHex, timingSafeEqual } from '../signature';
import { priceFrom, type FetchLike } from '../types';
import { MEDUSA_PRODUCT, MEDUSA_PROMOTION, SHOPIFY_DISCOUNTS, SHOPIFY_PRODUCT, json, medusaProduct } from './fixtures';

const medusa = (fetch: unknown) =>
  new MedusaAdapter({ apiUrl: 'https://medusa.example/', apiKey: 'sk_test_123456', webhookSecret: 'whsec_medusa_123' }, fetch as FetchLike);
const shopify = (fetch: unknown) =>
  new ShopifyAdapter({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123456789', webhookSecret: 'shpss_secret_123' }, fetch as FetchLike);

describe('Medusa adapter', () => {
  it('maps products with public price tiers (price-list prices excluded) and authenticates with the secret key', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ products: [MEDUSA_PRODUCT], count: 1 }));
    const page = await medusa(fetch).listProducts(null);
    expect(page.next).toBeNull();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toMatch(/^https:\/\/medusa\.example\/admin\/products\?limit=50&offset=0&fields=/);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('sk_test_123456:')}`);
    expect(page.products[0]).toMatchObject({ externalId: 'prod_01', handle: 'trail-shoe', published: true });
    expect(page.products[0]!.variants[0]!.prices).toEqual([
      { currency: 'EUR', amount: 120, minQuantity: null, maxQuantity: 9 },
      { currency: 'EUR', amount: 99.5, minQuantity: 10, maxQuantity: null },
      { currency: 'USD', amount: 130, minQuantity: null, maxQuantity: null },
    ]);
    expect(priceFrom(page.products[0]!)).toEqual({ amount: 99.5, currency: 'EUR' });
    expect(mapMedusaProduct(medusaProduct({ status: 'draft' })).published).toBe(false);
  });

  it('pages by offset and maps promotions', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ products: Array.from({ length: 50 }, (_, i) => medusaProduct({ id: `p${i}` })), count: 51 }))
      .mockResolvedValueOnce(json({ promotions: [MEDUSA_PROMOTION], count: 1 }));
    const a = medusa(fetch);
    expect((await a.listProducts(null)).next).toBe('50');
    expect(await a.listPromotions()).toEqual([
      { externalId: 'promo_01', title: 'Winter sale', code: 'WINTER10', kind: 'percentage', value: 10, currency: null, active: true, startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2027-01-31T00:00:00.000Z' },
    ]);
  });

  it('maps upstream errors and a missing product', async () => {
    expect(await medusa(vi.fn().mockResolvedValue(new Response('', { status: 404 }))).getProduct('x')).toBeNull();
    await expect(medusa(vi.fn().mockResolvedValue(new Response('', { status: 401 }))).listProducts(null)).rejects.toMatchObject({ code: 'COMMERCE_CREDENTIALS_REJECTED', status: 422 });
    await expect(medusa(vi.fn().mockResolvedValue(new Response('', { status: 429 }))).listProducts(null)).rejects.toMatchObject({ code: 'COMMERCE_RATE_LIMITED' });
    await expect(medusa(vi.fn().mockResolvedValue(new Response('', { status: 500 }))).listProducts(null)).rejects.toMatchObject({ code: 'COMMERCE_UNAVAILABLE', status: 502 });
  });

  it('verifies the X-Lumi-Signature HMAC and parses events', async () => {
    const a = medusa(vi.fn());
    const body = JSON.stringify({ event: 'product.updated', data: { id: 'prod_01' } });
    const good = new Headers({ 'x-lumi-signature': `sha256=${await hmacHex('whsec_medusa_123', body)}` });
    expect(await a.verifyWebhook(body, good)).toBe(true);
    expect(await a.verifyWebhook(`${body} `, good)).toBe(false);
    expect(await a.verifyWebhook(body, new Headers())).toBe(false);
    expect(a.parseWebhook(body)).toEqual({ kind: 'product', action: 'upsert', externalId: 'prod_01' });
    expect(a.parseWebhook(JSON.stringify({ event: 'product.deleted', data: { id: 'prod_01' } }))).toEqual({ kind: 'product', action: 'delete', externalId: 'prod_01' });
    expect(a.parseWebhook(JSON.stringify({ event: 'promotion.created', data: { id: 'promo_01' } }))).toMatchObject({ kind: 'promotion' });
    expect(a.parseWebhook(JSON.stringify({ event: 'order.placed', data: { id: 'o' } }))).toMatchObject({ kind: 'ignore' });
    expect(a.parseWebhook('nope')).toMatchObject({ kind: 'ignore' });
  });
});

describe('Shopify adapter', () => {
  it('refuses any host but <store>.myshopify.com', () => {
    expect(() => new ShopifyAdapter({ shopDomain: 'evil.example', accessToken: 'x'.repeat(10), webhookSecret: 'y'.repeat(10) }, vi.fn() as unknown as FetchLike)).toThrow(/myshopify/);
  });

  it('reads the shop currency once and maps products with compare-at prices', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ data: { shop: { currencyCode: 'USD' } } }))
      .mockResolvedValueOnce(json({ data: { products: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [SHOPIFY_PRODUCT] } } }))
      .mockResolvedValueOnce(json({ data: { product: SHOPIFY_PRODUCT } }));
    const a = shopify(fetch);
    const page = await a.listProducts(null);
    expect(page.next).toBe('c1');
    expect(page.products[0]).toMatchObject({ externalId: 'gid://shopify/Product/1001', handle: 'mug', published: true, thumbnail: 'https://cdn.shopify.example/mug.png' });
    expect(page.products[0]!.variants[0]).toEqual({
      externalId: 'gid://shopify/ProductVariant/2001',
      title: 'Default Title',
      sku: null,
      prices: [{ currency: 'USD', amount: 12.5, minQuantity: null, maxQuantity: null, compareAt: 15 }],
    });
    await a.getProduct('gid://shopify/Product/1001');
    expect(fetch).toHaveBeenCalledTimes(3);
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe('https://acme.myshopify.com/admin/api/2025-01/graphql.json');
    expect((init.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_123456789');
  });

  it('maps basic discounts and skips other discount types', async () => {
    const fetch = vi.fn().mockResolvedValue(json({ data: SHOPIFY_DISCOUNTS }));
    expect(await shopify(fetch).listPromotions()).toEqual([
      { externalId: 'gid://shopify/DiscountCodeNode/1', title: 'Ten off', code: 'TEN', kind: 'percentage', value: 10, currency: null, active: true, startsAt: '2026-11-01T00:00:00Z', endsAt: null },
    ]);
  });

  it('maps GraphQL throttling and errors', async () => {
    await expect(shopify(vi.fn().mockResolvedValue(json({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }))).listPromotions()).rejects.toMatchObject({ code: 'COMMERCE_RATE_LIMITED' });
    await expect(shopify(vi.fn().mockResolvedValue(json({ errors: [{ message: 'boom' }] }))).listPromotions()).rejects.toMatchObject({ code: 'COMMERCE_UNAVAILABLE' });
  });

  it('verifies X-Shopify-Hmac-Sha256 and parses product topics', async () => {
    const a = shopify(vi.fn());
    const body = JSON.stringify({ id: 1001, admin_graphql_api_id: 'gid://shopify/Product/1001' });
    const headers = new Headers({ 'x-shopify-hmac-sha256': await hmacBase64('shpss_secret_123', body), 'x-shopify-topic': 'products/update' });
    expect(await a.verifyWebhook(body, headers)).toBe(true);
    expect(await a.verifyWebhook(body, new Headers({ 'x-shopify-hmac-sha256': await hmacBase64('wrong', body) }))).toBe(false);
    expect(a.parseWebhook(body, headers)).toEqual({ kind: 'product', action: 'upsert', externalId: 'gid://shopify/Product/1001' });
    expect(a.parseWebhook(JSON.stringify({ id: 7 }), new Headers({ 'x-shopify-topic': 'products/delete' }))).toEqual({ kind: 'product', action: 'delete', externalId: 'gid://shopify/Product/7' });
    expect(a.parseWebhook(body, new Headers({ 'x-shopify-topic': 'orders/create' }))).toMatchObject({ kind: 'ignore' });
  });
});

describe('signature helpers', () => {
  it('compares in constant time and only equal strings match', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });
});
