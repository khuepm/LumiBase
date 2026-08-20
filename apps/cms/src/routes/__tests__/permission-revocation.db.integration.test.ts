import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  apiKeyPolicies,
  apiKeys,
  collections,
  createDb,
  fields,
  permissions as permissionsTable,
  policies,
  sites,
  type Database,
} from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { itemsRouter } from '../items';
import {
  PermissionService,
  __resetPermissionProcessCacheForTests,
} from '../../services/permission-service';

/**
 * Permission revocation against a real Postgres
 * (high-load-cache-readiness task 2.3; Req 2.5; design §13.1 Property P9).
 *
 * The unit-level counterpart (`permission-cache-versioning.test.ts`) stubs
 * `compile()` and proves the cache-key protocol. This file removes both stubs
 * that matter: the bundle is compiled from real `policies` / `permissions` /
 * `api_key_policies` rows, and the assertion is the HTTP status the API
 * actually returns — not a service return value.
 *
 * What it is here to catch: a revocation that only takes effect once a TTL
 * expires. Every case below runs inside the 60s entry TTL and the 5s
 * process-cache TTL (#391), so a pass means the version bump — not expiry —
 * did the work. Skips without DATABASE_URL.
 *
 * **Validates: Req 2.5 (revoke → next request denied), Property P9**
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;
const SITE = 'site_perm_revoke_it';
const API_KEY = 'key_perm_revoke_it';

describe('permission revocation — DB integration', () => {
  let db: Database;
  let canConnect = false;
  let cache: MemoryCacheProvider;
  let policyId = '';

  /**
   * One app whose principal is an API key, built the way the real stack builds
   * it: `itemServiceForRequest` reads `runtime.cache`, so the request goes
   * through the versioned bundle cache rather than around it.
   */
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    (c as unknown as { env: Record<string, unknown> }).env = {};
    c.set('db', db);
    c.set('siteId', SITE);
    c.set('auth', {
      apiKeyId: API_KEY,
      apiKey: { id: API_KEY, name: 'Revoke IT' },
      roles: [],
      raw: {},
    } as unknown as AppEnv['Variables']['auth']);
    c.set('runtime', {
      cache,
      search: undefined,
      queue: undefined,
      edgeCache: undefined,
    } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/items', itemsRouter);

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping permission-revocation DB test: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping permission-revocation DB test: database not reachable.');
    }
  });

  afterAll(async () => {
    if (!canConnect) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(apiKeys).where(eq(apiKeys.id, API_KEY)).catch(() => undefined);
  });

  beforeEach(async () => {
    if (!canConnect) return;

    // A fresh cache per case, and a cleared process store (#391) — otherwise a
    // later case could be answered from an earlier one's entry and pass for
    // the wrong reason.
    cache = new MemoryCacheProvider();
    __resetPermissionProcessCacheForTests();

    await db.delete(apiKeys).where(eq(apiKeys.id, API_KEY));
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Perm Revoke IT' });

    const postsId = (
      await db
        .insert(collections)
        .values({ siteId: SITE, name: 'posts', label: 'Posts' })
        .returning({ id: collections.id })
    )[0]!.id;
    await db.insert(fields).values({
      siteId: SITE,
      collectionId: postsId,
      name: 'title',
      type: 'string',
      interface: 'input',
    });

    // A non-admin policy: admin bypass would skip the permission rows entirely
    // and make the revocation untestable.
    policyId = (
      await db
        .insert(policies)
        .values({ siteId: SITE, name: 'Posts reader', adminAccess: false, appAccess: false })
        .returning({ id: policies.id })
    )[0]!.id;
    await db.insert(permissionsTable).values({
      siteId: SITE,
      policyId,
      collection: 'posts',
      action: 'read',
      fields: ['*'],
    });

    await db.insert(apiKeys).values({
      id: API_KEY,
      siteId: SITE,
      name: 'Revoke IT',
      // The auth middleware is stubbed here, so the token never has to verify;
      // both columns exist only to satisfy NOT NULL.
      prefix: 'lmbtest',
      tokenHash: 'not-a-real-hash-auth-is-stubbed-in-this-test',
    });
    await db.insert(apiKeyPolicies).values({ siteId: SITE, apiKeyId: API_KEY, policyId, priority: 0 });
  });

  /** Detach the policy from the key — the write a revoke endpoint performs. */
  async function detachPolicy(): Promise<void> {
    await db
      .delete(apiKeyPolicies)
      .where(and(eq(apiKeyPolicies.apiKeyId, API_KEY), eq(apiKeyPolicies.siteId, SITE)));
  }

  it.skipIf(!TEST_DATABASE_URL)(
    'grants the read while the policy is attached, then denies it with 403 on the next request after revoke (Req 2.5, P9)',
    async () => {
      if (!canConnect) return;

      const granted = await app.request('/api/v1/items/posts');
      expect(granted.status).toBe(200);

      // The bundle is now cached under v1 for this principal.
      expect(await cache.get(`perm:${SITE}:v1:api_key:${API_KEY}`)).not.toBeNull();

      await detachPolicy();
      await PermissionService.bumpVersion(cache, SITE);

      const denied = await app.request('/api/v1/items/posts');
      expect(denied.status).toBe(403);
      const body = (await denied.json()) as { errors?: Array<{ code?: string }> };
      expect(body.errors?.[0]?.code).toBe('FORBIDDEN');

      // Immediacy, stated as an assertion rather than assumed: the v1 entry is
      // still in the cache, well inside its TTL. The 403 came from the version
      // bump making that entry unaddressable, not from it expiring.
      expect(await cache.get(`perm:${SITE}:v1:api_key:${API_KEY}`)).not.toBeNull();
      expect(await cache.get(`perm:${SITE}:v2:api_key:${API_KEY}`)).not.toBeNull();
    },
  );

  it.skipIf(!TEST_DATABASE_URL)(
    'keeps serving the stale grant when the write path forgets to bump — the bump is what revokes',
    async () => {
      if (!canConnect) return;

      expect((await app.request('/api/v1/items/posts')).status).toBe(200);

      // Same DB write, no bump. This is the regression this pair of tests
      // exists for: it pins the blast radius of a route that mutates
      // permissions without calling `bumpPermissionVersion`.
      await detachPolicy();

      const stillGranted = await app.request('/api/v1/items/posts');
      expect(stillGranted.status).toBe(200);

      // And the bump repairs it, without any wait.
      await PermissionService.bumpVersion(cache, SITE);
      expect((await app.request('/api/v1/items/posts')).status).toBe(403);
    },
  );

  it.skipIf(!TEST_DATABASE_URL)(
    'denies from a cold cache too — the DB, not the cache, is the source of truth',
    async () => {
      if (!canConnect) return;

      await detachPolicy();

      // No prior read, so nothing to invalidate: the first compile already
      // sees the detached state.
      expect((await app.request('/api/v1/items/posts')).status).toBe(403);
    },
  );

  it.skipIf(!TEST_DATABASE_URL)(
    'revoking in one site leaves another site untouched (DoD 2b two-site check)',
    async () => {
      if (!canConnect) return;

      const OTHER = `${SITE}_b`;
      const OTHER_KEY = `${API_KEY}_b`;
      try {
        // Clear anything a previously interrupted run left behind.
        await db.delete(apiKeys).where(eq(apiKeys.id, OTHER_KEY));
        await db.delete(sites).where(eq(sites.id, OTHER));
        await db.insert(sites).values({ id: OTHER, name: 'Perm Revoke IT B' });
        const otherPosts = (
          await db
            .insert(collections)
            .values({ siteId: OTHER, name: 'posts', label: 'Posts' })
            .returning({ id: collections.id })
        )[0]!.id;
        await db.insert(fields).values({
          siteId: OTHER,
          collectionId: otherPosts,
          name: 'title',
          type: 'string',
          interface: 'input',
        });
        const otherPolicy = (
          await db
            .insert(policies)
            .values({ siteId: OTHER, name: 'Posts reader', adminAccess: false, appAccess: false })
            .returning({ id: policies.id })
        )[0]!.id;
        await db.insert(permissionsTable).values({
          siteId: OTHER,
          policyId: otherPolicy,
          collection: 'posts',
          action: 'read',
          fields: ['*'],
        });
        await db.insert(apiKeys).values({
          id: OTHER_KEY,
          siteId: OTHER,
          name: 'Revoke IT B',
          prefix: 'lmbtstb',
          // `token_hash` is globally unique, so site B needs its own value.
          tokenHash: 'not-a-real-hash-auth-is-stubbed-in-this-test-site-b',
        });
        await db
          .insert(apiKeyPolicies)
          .values({ siteId: OTHER, apiKeyId: OTHER_KEY, policyId: otherPolicy, priority: 0 });

        // Site B's own app, sharing the same cache instance so a leaky bump
        // would show up here.
        const appB = new Hono<AppEnv>();
        appB.use('*', async (c, next) => {
          (c as unknown as { env: Record<string, unknown> }).env = {};
          c.set('db', db);
          c.set('siteId', OTHER);
          c.set('auth', {
            apiKeyId: OTHER_KEY,
            apiKey: { id: OTHER_KEY, name: 'Revoke IT B' },
            roles: [],
            raw: {},
          } as unknown as AppEnv['Variables']['auth']);
          c.set('runtime', {
            cache,
            search: undefined,
            queue: undefined,
            edgeCache: undefined,
          } as unknown as AppEnv['Variables']['runtime']);
          await next();
        });
        appB.route('/api/v1/items', itemsRouter);

        expect((await app.request('/api/v1/items/posts')).status).toBe(200);
        expect((await appB.request('/api/v1/items/posts')).status).toBe(200);

        await detachPolicy();
        await PermissionService.bumpVersion(cache, SITE);

        expect((await app.request('/api/v1/items/posts')).status).toBe(403);
        expect((await appB.request('/api/v1/items/posts')).status).toBe(200);
      } finally {
        await db.delete(apiKeys).where(eq(apiKeys.id, OTHER_KEY)).catch(() => undefined);
        await db.delete(sites).where(eq(sites.id, OTHER)).catch(() => undefined);
      }
    },
  );
});
