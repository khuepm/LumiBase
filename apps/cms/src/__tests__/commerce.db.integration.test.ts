import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { agentToolSecrets, collections, items, roles, sites, users, userSites, type Database } from '@lumibase/database';
import { MemoryCacheProvider, type KeyProvider } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { hmacBase64, hmacHex } from '../modules/commerce/signature';
import { MEDUSA_PROMOTION, SHOPIFY_PRODUCT, json, medusaProduct } from '../modules/commerce/__tests__/fixtures';

vi.mock('../middleware/site-admin', () => ({
  requireSiteAdmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
  isSiteAdmin: async () => true,
}));

const { commerceRouter } = await import('../modules/commerce/routes');
const { commerceWebhookRouter } = await import('../modules/commerce/webhook');
const { commerceDeps } = await import('../modules/commerce/config');

/**
 * Commerce adapters on real PostgreSQL (#764): connect Medusa and Shopify
 * (credentials encrypted, never returned), a signed webhook makes a product
 * change appear at once, a forged one is refused, a full sync pulls every
 * page and prunes what the provider dropped, and prices keep their tiers.
 * Providers are fetch mocks; the SSRF guard is exercised without the seam.
 */

const SITE = 'site_commerce_it';
/** A real site admin: the admin sync runs with the caller's own permission context. */
const ADMIN = 'usr_commerce_it_admin';
const MEDUSA = { apiUrl: 'https://medusa.example', apiKey: 'sk_test_integration', webhookSecret: 'whsec_integration' };
const SHOPIFY = { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_integration', webhookSecret: 'shpss_integration' };

const keys: KeyProvider = {
  getActiveKey: async () => ({ keyId: 'v1', key: Buffer.alloc(32, 9).toString('base64') }),
  getKey: async () => Buffer.alloc(32, 9).toString('base64'),
  listKeys: async () => [{ keyId: 'v1', status: 'active', algo: 'AES-GCM' }],
};

/** In-memory Medusa catalogue behind a fetch mock. */
let catalogue = new Map<string, ReturnType<typeof medusaProduct>>();
let shopifyProduct: typeof SHOPIFY_PRODUCT | null = SHOPIFY_PRODUCT;
const calls: string[] = [];
const providerFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  calls.push(url);
  const u = new URL(url);
  if (u.host === 'medusa.example') {
    if ((init?.headers as Record<string, string>)?.Authorization !== `Basic ${btoa(`${MEDUSA.apiKey}:`)}`) return new Response('', { status: 401 });
    const one = /^\/admin\/products\/([^/]+)$/.exec(u.pathname);
    if (one) {
      const p = catalogue.get(decodeURIComponent(one[1]!));
      return p ? json({ product: p }) : new Response('', { status: 404 });
    }
    if (u.pathname === '/admin/products') {
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const all = [...catalogue.values()];
      return json({ products: all.slice(offset, offset + 50), count: all.length });
    }
    if (u.pathname === '/admin/promotions') return json({ promotions: [MEDUSA_PROMOTION], count: 1 });
  }
  if (u.host === 'acme.myshopify.com') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { query: string };
    if (body.query.includes('shop {')) return json({ data: { shop: { currencyCode: 'USD' } } });
    if (body.query.includes('product(id')) return json({ data: { product: shopifyProduct } });
    if (body.query.includes('products(first')) return json({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: shopifyProduct ? [shopifyProduct] : [] } } });
    if (body.query.includes('discountNodes')) return json({ data: { discountNodes: { nodes: [] } } });
  }
  return new Response('', { status: 500 });
};

describe.skipIf(!hasDbIntegrationUrl)('commerce adapters (real PostgreSQL)', () => {
  let db: Database;
  const cache = new MemoryCacheProvider();

  const app = () => {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      c.set('db', db as never);
      c.set('siteId', SITE);
      c.set('auth', { userId: ADMIN, roles: [], raw: {} } as unknown as AppEnv['Variables']['auth']);
      c.set('runtime', { cache, keys, queue: { enqueue: async () => undefined } } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    a.route('/api/v1/integrations/commerce', commerceRouter);
    a.route('/api/v1/commerce-webhooks', commerceWebhookRouter);
    return a;
  };
  const admin = (path: string, method: string, body?: unknown) =>
    app().request(`https://cms.example/api/v1/integrations/commerce${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, {});
  const hook = (provider: string, body: string, headers: Record<string, string>, site = SITE) =>
    app().request(`/api/v1/commerce-webhooks/${site}/${provider}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  const medusaHook = async (event: string, id: string, secret = MEDUSA.webhookSecret) => {
    const body = JSON.stringify({ event, data: { id } });
    return hook('medusa', body, { 'X-Lumi-Signature': `sha256=${await hmacHex(secret, body)}` });
  };
  const product = async (externalId: string) => {
    const [col] = await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'commerce_products')));
    const rows = await db.select().from(items).where(and(eq(items.siteId, SITE), eq(items.collectionId, col!.id)));
    return rows.find((r) => (r.data as { external_id?: string }).external_id === externalId && !r.deletedAt) ?? null;
  };

  beforeAll(async () => {
    db = await connectDbIntegration('commerce');
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE, name: SITE });
    await db.insert(users).values({ id: ADMIN, email: 'commerce-it@example.dev' }).onConflictDoNothing();
    const [role] = await db.insert(roles).values({ siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true }).returning({ id: roles.id });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: role!.id });
    catalogue = new Map([['prod_01', medusaProduct()]]);
    commerceDeps.fetch = providerFetch;
  });

  afterAll(async () => {
    commerceDeps.fetch = undefined;
    if (db) await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  it('connects Medusa after checking the credentials, stores them encrypted and never returns them', async () => {
    expect((await admin('/medusa', 'PUT', { ...MEDUSA, apiKey: 'sk_wrong_key' })).status).toBe(422);
    expect((await admin('/medusa', 'PUT', { ...MEDUSA, apiUrl: 'ftp://medusa.example' })).status).toBe(400);
    const res = await admin('/medusa', 'PUT', MEDUSA);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ provider: 'medusa', apiUrl: 'https://medusa.example', connected: true, webhookUrl: `https://cms.example/api/v1/commerce-webhooks/${SITE}/medusa` });
    expect(body.data.createdCollections).toEqual(['commerce_products', 'commerce_promotions', 'block_product_card', 'block_promotion']);
    const status = JSON.stringify(await (await admin('', 'GET')).json());
    expect(status).not.toContain(MEDUSA.apiKey);
    expect(status).not.toContain(MEDUSA.webhookSecret);
    const [row] = await db.select().from(agentToolSecrets).where(and(eq(agentToolSecrets.siteId, SITE), eq(agentToolSecrets.name, 'COMMERCE_MEDUSA')));
    expect(row!.ciphertext).not.toContain(MEDUSA.apiKey);
  });

  it('a signed webhook makes a product change appear immediately, with its price tiers', async () => {
    const created = await medusaHook('product.created', 'prod_01');
    expect(created.status, await created.clone().text()).toBe(200);
    expect(await created.json()).toEqual({ data: { product: 'prod_01', result: 'created' } });
    const row = await product('prod_01');
    expect(row).toMatchObject({ status: 'published' });
    const data = row!.data as { title: string; price_from: number; currency: string; variants: Array<{ prices: unknown[] }> };
    expect(data).toMatchObject({ title: 'Trail Shoe', price_from: 99.5, currency: 'EUR', provider: 'medusa', external_id: 'prod_01' });
    expect(data.variants[0]!.prices).toContainEqual({ currency: 'EUR', amount: 99.5, minQuantity: 10, maxQuantity: null });

    catalogue.set('prod_01', medusaProduct({ title: 'Trail Shoe v2', status: 'draft' }));
    expect(await (await medusaHook('product.updated', 'prod_01')).json()).toEqual({ data: { product: 'prod_01', result: 'updated' } });
    expect(await product('prod_01')).toMatchObject({ status: 'draft', data: expect.objectContaining({ title: 'Trail Shoe v2' }) });
  });

  it('refuses a forged or unsigned webhook, and an unknown site or provider', async () => {
    catalogue.set('prod_01', medusaProduct({ title: 'Forged' }));
    expect((await medusaHook('product.updated', 'prod_01', 'not-the-secret')).status).toBe(401);
    expect((await hook('medusa', '{"event":"product.updated","data":{"id":"prod_01"}}', {})).status).toBe(401);
    expect((await product('prod_01'))!.data).toMatchObject({ title: 'Trail Shoe v2' });
    expect((await hook('shopify', '{}', {})).status).toBe(404); // not connected
    expect((await hook('woo', '{}', {})).status).toBe(404);
    expect((await hook('medusa', '{}', {}, 'site_nope_x')).status).toBe(404);
    // An unhandled event is acknowledged, not retried.
    expect(await (await medusaHook('order.placed', 'o1')).json()).toMatchObject({ data: { ignored: expect.any(String) } });
  });

  it('a full sync pulls every page, syncs promotions and prunes what the provider dropped', async () => {
    catalogue = new Map(Array.from({ length: 60 }, (_, i) => [`p${i}`, medusaProduct({ id: `p${i}`, handle: `p-${i}`, title: `P${i}` })]));
    const res = await admin('/medusa/sync', 'POST');
    expect(res.status, await res.clone().text()).toBe(200);
    const result = ((await res.json()) as { data: { products: Record<string, number>; promotions: Record<string, number>; truncated: boolean } }).data;
    expect(result).toEqual({ products: { created: 60, updated: 0, deleted: 1 }, promotions: { created: 1, updated: 0, deleted: 0 }, truncated: false });
    expect(await product('prod_01')).toBeNull();
    expect(calls.filter((u) => u.includes('/admin/products?')).length).toBeGreaterThanOrEqual(2);

    // Deleted upstream → deleted here, through the webhook.
    catalogue.delete('p0');
    expect(await (await medusaHook('product.deleted', 'p0')).json()).toEqual({ data: { product: 'p0', result: 'deleted' } });
    expect(await product('p0')).toBeNull();
  });

  it('Shopify: connect, webhook with X-Shopify-Hmac-Sha256, compare-at price kept', async () => {
    expect((await admin('/shopify', 'PUT', { ...SHOPIFY, shopDomain: 'evil.example' })).status).toBe(400);
    expect((await admin('/shopify', 'PUT', SHOPIFY)).status).toBe(200);
    const body = JSON.stringify({ id: 1001, admin_graphql_api_id: 'gid://shopify/Product/1001' });
    const res = await hook('shopify', body, { 'X-Shopify-Hmac-Sha256': await hmacBase64(SHOPIFY.webhookSecret, body), 'X-Shopify-Topic': 'products/update' });
    expect(await res.json()).toEqual({ data: { product: 'gid://shopify/Product/1001', result: 'created' } });
    const row = await product('gid://shopify/Product/1001');
    expect(row!.data).toMatchObject({ provider: 'shopify', price_from: 12.5, currency: 'USD' });
    expect((row!.data as { variants: Array<{ prices: Array<{ compareAt: number }> }> }).variants[0]!.prices[0]!.compareAt).toBe(15);
    // Medusa rows are untouched by the Shopify provider.
    expect(await product('p1')).not.toBeNull();
  });

  it('refuses a private or loopback Medusa URL (SSRF guard, no test seam)', async () => {
    commerceDeps.fetch = undefined;
    try {
      const res = await admin('/medusa', 'PUT', { ...MEDUSA, apiUrl: 'http://127.0.0.1:9000' });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('COMMERCE_UNREACHABLE');
    } finally {
      commerceDeps.fetch = providerFetch;
    }
  });

  it('disconnects', async () => {
    expect(await (await admin('/medusa', 'DELETE')).json()).toEqual({ data: { provider: 'medusa', connected: false } });
    expect((await medusaHook('product.updated', 'p1')).status).toBe(404);
  });
});
