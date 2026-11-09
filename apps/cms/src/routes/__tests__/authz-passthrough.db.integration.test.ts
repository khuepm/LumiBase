import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { sites, users, policies, userPolicies, permissions, collections, extensions, type Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { adminRouter } from '../admin';
import { mediaRouter } from '../media';
import { marketplaceRouter } from '../marketplace';
import { ExtensionVerifierService } from '../../services/extension-verifier';

const SITE = 'authz580_passthrough';
const OTHER = 'authz580_other';
const USER = 'authz580_user';
const POLICY = 'authz580_policy';
const SLUG = 'authz580-extension';

describe.skipIf(!hasDbIntegrationUrl)('#580 REST passthrough authorization with real policies', () => {
  let db: Database;
  let objects: Map<string, Uint8Array>;
  let writes: string[];
  beforeAll(async () => { db = await connectDbIntegration('authz-passthrough'); });
  const cleanup = async () => {
    await db.delete(extensions).where(eq(extensions.marketplaceSlug, SLUG));
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(sites).where(eq(sites.id, OTHER));
    await db.delete(users).where(eq(users.id, USER));
  };
  beforeEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
    objects = new Map(); writes = [];
    await db.insert(sites).values([{ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE, name: SITE }, { organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: OTHER, name: OTHER }]);
    await db.insert(users).values({ id: USER, email: 'synthetic580@example.test' });
    await db.insert(policies).values({ id: POLICY, siteId: SITE, name: POLICY, adminAccess: false });
    await db.insert(userPolicies).values({ userId: USER, siteId: SITE, policyId: POLICY });
  });
  afterAll(async () => { vi.restoreAllMocks(); if (db) await cleanup(); });
  function app(siteId = SITE, authenticated = true) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db); c.set('siteId', siteId);
      c.set('auth', authenticated ? { userId: USER, roles: ['admin'], raw: {} } : { roles: [], raw: {} });
      c.set('runtime', { storage: {
        list: async (prefix: string) => ({ keys: [...objects.keys()].filter((key) => key.startsWith(prefix)) }),
        get: async (key: string) => objects.has(key) ? { body: objects.get(key), size: objects.get(key)!.length, metadata: { contentType: 'application/octet-stream' } } : null,
        put: async (key: string, data: Uint8Array) => { writes.push(key); objects.set(key, new Uint8Array(data)); },
        delete: async (key: string) => { writes.push(key); objects.delete(key); },
      } } as never);
      await next();
    });
    app.route('/admin', adminRouter); app.route('/media', mediaRouter); app.route('/marketplace', marketplaceRouter);
    return app;
  }
  async function grant(collection: string, action: string) {
    await db.insert(permissions).values({ siteId: SITE, policyId: POLICY, collection, action, fields: ['*'] });
  }
  async function revoke() {
    await db.delete(userPolicies).where(and(eq(userPolicies.siteId, SITE), eq(userPolicies.userId, USER)));
  }
  const restoreBody = JSON.stringify({ type: 'collections', data: { id: 'authz580_restored', siteId: OTHER, name: 'restored', label: 'Restored' } });
  it('backup and restore require site-bound admin access and enforce revocation before writes', async () => {
    expect((await app().request('/admin/backup')).status).toBe(403);
    expect((await app().request('/admin/restore', { method: 'POST', body: restoreBody })).status).toBe(403);
    await db.update(policies).set({ adminAccess: true }).where(eq(policies.id, POLICY));
    expect((await app().request('/admin/backup')).status).toBe(200);
    expect((await app(OTHER).request('/admin/backup')).status).toBe(403);
    expect((await app().request('/admin/restore', { method: 'POST', body: restoreBody })).status).toBe(200);
    expect(await db.select({ siteId: collections.siteId }).from(collections).where(eq(collections.id, 'authz580_restored'))).toEqual([{ siteId: SITE }]);
    await revoke();
    expect((await app().request('/admin/restore', { method: 'POST', body: restoreBody })).status).toBe(403);
    expect((await app().request('/admin/backup')).status).toBe(403);
  });
  it('binary media requires separate read/create/delete grants and keeps storage tenant-scoped', async () => {
    const payload = new Uint8Array([0, 255, 1, 9]);
    expect((await app().request('/media/probe.bin', { method: 'POST', body: payload })).status).toBe(403);
    expect(writes).toEqual([]);
    await grant('media', 'create');
    expect((await app().request('/media/probe.bin', { method: 'POST', body: payload })).status).toBe(201);
    expect((await app().request('/media/probe.bin')).status).toBe(403);
    await grant('media', 'read');
    const read = await app().request('/media/probe.bin');
    expect(read.status).toBe(200); expect(new Uint8Array(await read.arrayBuffer())).toEqual(payload);
    expect((await app(OTHER).request('/media/probe.bin')).status).toBe(403);
    expect((await app().request('/media/probe.bin', { method: 'DELETE' })).status).toBe(403);
    await grant('media', 'delete');
    expect((await app().request('/media/probe.bin', { method: 'DELETE' })).status).toBe(204);
    await revoke();
    expect((await app().request('/media')).status).toBe(403);
    expect(writes).toEqual([`sites/${SITE}/media/probe.bin`, `sites/${SITE}/media/probe.bin`]);
  });
  it('marketplace install checks actual policy before signature lookup and tenant mutation', async () => {
    await db.insert(extensions).values({ id: 'authz580_catalog', siteId: null, name: SLUG, marketplaceSlug: SLUG, version: '1.0.0', type: 'hook', bundleUrl: 'https://example.test/synthetic.js', publishedAt: new Date() });
    // Signature verification is a separate cryptographic boundary. Authorization
    // and installation below use real policies and database transactions.
    const verify = vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata').mockResolvedValue({ ok: true, isOfficial: false } as never);
    const path = `/marketplace/extensions/${SLUG}/install`;
    expect((await app().request(path, { method: 'POST' }, {})).status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    await grant('extensions', 'install');
    expect((await app().request(path, { method: 'POST' }, {})).status).toBe(201);
    expect((await app(OTHER).request(path, { method: 'POST' }, {})).status).toBe(403);
    await revoke();
    expect((await app().request(path, { method: 'POST' }, {})).status).toBe(403);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(await db.select().from(extensions).where(eq(extensions.siteId, OTHER))).toHaveLength(0);
    expect(await db.select().from(extensions).where(eq(extensions.siteId, SITE))).toHaveLength(1);
  });
  it.each(['/admin/backup', '/media', '/marketplace/extensions/authz580-extension/install'])('refuses an unauthenticated route context for %s', async (path) => {
    const method = path.includes('/install') ? 'POST' : 'GET';
    expect((await app(SITE, false).request(path, { method }, {})).status).toBe(403);
    expect(writes).toEqual([]);
  });
});
