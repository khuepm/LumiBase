import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { openApiRouter } from '../openapi';
import { PermissionService } from '../../services/permission-service';
import { TypegenService } from '../../services/typegen-service';
import { AuditLogger } from '../../modules/audit/logger';
import { bumpSchemaVersion } from '../../services/schema-version';
import { OPENAPI_SETTINGS_KEY } from '../../services/openapi/openapi-config';
import {
  ADMIN_BUNDLE,
  bundleOf,
  matrixManifest,
  perm,
  propertyKeys,
  validateOpenApi,
} from '../../services/openapi/__tests__/fixtures';

/** In-memory `CacheProvider` subset the route touches. */
function memoryCache() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    increment: vi.fn(async (key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(next));
      return next;
    }),
    invalidateByTag: vi.fn(async () => undefined),
  };
}

/** Fake db: one `settings` row (or none) + captured upserts. */
function fakeDb(initial: unknown) {
  let stored: unknown = initial;
  const upserts: unknown[] = [];
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: async () => (stored === undefined ? [] : [{ value: stored }]),
      }),
    }),
  });
  const insert = vi.fn(() => ({
    values: (row: { key: string; value: unknown }) => ({
      onConflictDoUpdate: async () => {
        expect(row.key).toBe(OPENAPI_SETTINGS_KEY);
        stored = row.value;
        upserts.push(row.value);
      },
    }),
  }));
  return { select, insert, upserts };
}

type Auth = Record<string, unknown>;

function appFor(auth: Auth | undefined, db: ReturnType<typeof fakeDb>, cache = memoryCache(), siteId = 'site-a') {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', siteId);
    if (auth) c.set('auth', auth as never);
    c.set('db', db as never);
    c.set('runtime', { cache } as never);
    await next();
  });
  app.route('/api/v1', openApiRouter);
  // Same notFound as `index.ts`, so the "disabled" 404 can be compared byte for byte.
  app.notFound((c) => c.json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] }, 404));
  return { app, cache };
}

const STUDIO: Auth = { userId: 'u1', roles: ['editor'], raw: {} };
const FRONTEND: Auth = { userId: 'u2', roles: ['subscriber'], isFrontendUser: true, raw: {} };
const ANON: Auth = { type: 'anonymous', roleId: 'role_public', roles: ['role_public'], raw: { anonymous: true } };
const DEV_ADMIN: Auth = { roles: ['admin'], raw: { dev: true } };

let manifestSpy: ReturnType<typeof vi.spyOn>;
let bundleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  manifestSpy = vi.spyOn(TypegenService.prototype, 'getManifest').mockResolvedValue(matrixManifest());
  bundleSpy = vi.spyOn(PermissionService.prototype, 'bundle').mockResolvedValue(ADMIN_BUNDLE);
  vi.spyOn(AuditLogger.prototype, 'write').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('GET /api/v1/openapi.json — config gate', () => {
  it('404s by default with the exact unknown-route body (no existence oracle)', async () => {
    const { app } = appFor(STUDIO, fakeDb(undefined));
    const res = await app.request('/api/v1/openapi.json');
    const unknown = await app.request('/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await unknown.text());
    expect(manifestSpy).not.toHaveBeenCalled();
  });

  it('404s when the stored value is malformed (fails closed)', async () => {
    const { app } = appFor(STUDIO, fakeDb({ enabled: 'yes' }));
    expect((await app.request('/api/v1/openapi.json')).status).toBe(404);
  });

  it('404s for a realm the site did not list', async () => {
    const db = fakeDb({ enabled: true, realms: ['studio'] });
    expect((await appFor(FRONTEND, db).app.request('/api/v1/openapi.json')).status).toBe(404);
    expect((await appFor(ANON, db).app.request('/api/v1/openapi.json')).status).toBe(404);
    expect((await appFor({ type: 'api_key', apiKeyId: 'k1', raw: {} }, db).app.request('/api/v1/openapi.json')).status).toBe(404);
  });

  it('serves a valid OpenAPI 3.1 document to an allowed realm', async () => {
    const { app } = appFor(STUDIO, fakeDb({ enabled: true, realms: ['studio'] }));
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc['openapi']).toBe('3.1.0');
    expect((await validateOpenApi(doc)).valid).toBe(true);
  });
});

describe('GET /api/v1/openapi.json — caller view', () => {
  it("lists only what the caller's permissions allow", async () => {
    bundleSpy.mockResolvedValue(bundleOf([perm('posts', 'read', ['title', 'cover'])]));
    const { app } = appFor(STUDIO, fakeDb({ enabled: true, realms: ['studio'] }));
    const doc = (await (await app.request('/api/v1/openapi.json')).json()) as Record<string, unknown>;
    const paths = Object.keys(doc['paths'] as object);
    expect(paths).toEqual(['/items/posts', '/items/posts/{id}', '/deliver/page/{site_id}/{slug}']);
    const keys = propertyKeys(doc);
    expect(keys.has('title')).toBe(true);
    expect(keys.has('secret_note')).toBe(false);
    expect(keys.has('salary')).toBe(false);
  });

  it('gives the anonymous realm the public role read surface only', async () => {
    bundleSpy.mockResolvedValue(bundleOf([perm('posts', 'read', ['title']), perm('posts', 'create')]));
    const { app } = appFor(ANON, fakeDb({ enabled: true, realms: ['public'] }));
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.paths['/items/posts']!)).toEqual(['get']);
    expect(JSON.stringify(doc)).not.toContain('CreateInput');
  });
});

describe('GET /api/v1/openapi.json — caching', () => {
  it('caches per (site, schema version, permission fingerprint) and invalidates on schema change', async () => {
    const db = fakeDb({ enabled: true, realms: ['studio'] });
    const cache = memoryCache();
    const { app } = appFor(STUDIO, db, cache);

    const first = await app.request('/api/v1/openapi.json');
    const second = await app.request('/api/v1/openapi.json');
    expect(await first.text()).toBe(await second.text());
    expect(manifestSpy).toHaveBeenCalledTimes(1);
    expect([...cache.store.keys()].some((key) => /^openapi:site-a:s0:[0-9a-f]{32}$/.test(key))).toBe(true);

    // Another permission set → its own entry, generated separately.
    bundleSpy.mockResolvedValue(bundleOf([perm('posts', 'read')]));
    await app.request('/api/v1/openapi.json');
    expect(manifestSpy).toHaveBeenCalledTimes(2);

    // A schema change (SchemaService.invalidate → bumpSchemaVersion) orphans the entry.
    manifestSpy.mockResolvedValue({ ...matrixManifest(), collections: matrixManifest().collections.slice(1) });
    await bumpSchemaVersion(cache as never, 'site-a');
    const after = (await (await app.request('/api/v1/openapi.json')).json()) as { paths: Record<string, unknown>; info: { version: string } };
    expect(manifestSpy).toHaveBeenCalledTimes(3);
    expect(after.info.version).toBe('schema-1');
    expect(Object.keys(after.paths)).not.toContain('/items/posts');
  });

  it('isolates sites that share one cache (DoD §2b two-site check)', async () => {
    const cache = memoryCache();
    const siteA = appFor(STUDIO, fakeDb({ enabled: true, realms: ['studio'] }), cache, 'site-a').app;
    const siteB = appFor(STUDIO, fakeDb(undefined), cache, 'site-b').app;
    const siteBEnabled = appFor(STUDIO, fakeDb({ enabled: true, realms: ['studio'] }), cache, 'site-b').app;

    expect((await siteA.request('/api/v1/openapi.json')).status).toBe(200);
    // B never enabled it: A's cached document must not leak through.
    expect((await siteB.request('/api/v1/openapi.json')).status).toBe(404);

    manifestSpy.mockResolvedValue({ ...matrixManifest(), site: 'site-b', collections: matrixManifest().collections.slice(3) });
    const docB = (await (await siteBEnabled.request('/api/v1/openapi.json')).json()) as Record<string, unknown>;
    expect(manifestSpy).toHaveBeenCalledTimes(2);
    expect((docB['x-lumibase'] as { site: string }).site).toBe('site-b');
    expect(Object.keys(docB['paths'] as object)).not.toContain('/items/posts');
    expect([...cache.store.keys()].filter((key) => key.startsWith('openapi:')).map((key) => key.split(':')[1]).sort()).toEqual([
      'site-a',
      'site-b',
    ]);
    // A schema change on B does not orphan A's entry.
    await bumpSchemaVersion(cache as never, 'site-b');
    await siteA.request('/api/v1/openapi.json');
    expect(manifestSpy).toHaveBeenCalledTimes(2);
  });

  it('answers a matching If-None-Match with 304', async () => {
    const { app } = appFor(STUDIO, fakeDb({ enabled: true, realms: ['studio'] }));
    const etag = (await app.request('/api/v1/openapi.json')).headers.get('etag');
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
    const res = await app.request('/api/v1/openapi.json', { headers: { 'if-none-match': etag! } });
    expect(res.status).toBe(304);
  });

  it('still serves when the cache backend throws', async () => {
    const cache = memoryCache();
    cache.get.mockRejectedValue(new Error('kv down'));
    cache.set.mockRejectedValue(new Error('kv down'));
    const { app } = appFor(STUDIO, fakeDb({ enabled: true, realms: ['studio'] }), cache);
    expect((await app.request('/api/v1/openapi.json')).status).toBe(200);
  });
});

describe('/api/v1/openapi/config', () => {
  it('is admin-only', async () => {
    bundleSpy.mockResolvedValue({ ...ADMIN_BUNDLE, admin: false });
    const db = fakeDb(undefined);
    const { app } = appFor(STUDIO, db);
    expect((await app.request('/api/v1/openapi/config')).status).toBe(403);
    const put = await app.request('/api/v1/openapi/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, realms: ['public'] }),
    });
    expect(put.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
    expect((await appFor(ANON, db).app.request('/api/v1/openapi/config')).status).toBe(403);
  });

  it('reads the disabled default, writes a validated value and audits it', async () => {
    const db = fakeDb(undefined);
    const { app } = appFor(DEV_ADMIN, db);
    const read = await app.request('/api/v1/openapi/config');
    expect(await read.json()).toEqual({ data: { enabled: false, realms: ['studio'] } });

    const put = await app.request('/api/v1/openapi/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, realms: ['studio', 'public'] }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ data: { enabled: true, realms: ['studio', 'public'] } });
    expect(db.upserts).toEqual([{ enabled: true, realms: ['studio', 'public'] }]);
    expect(AuditLogger.prototype.write).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'openapi_config_updated',
        metadata: { before: { enabled: false, realms: ['studio'] }, after: { enabled: true, realms: ['studio', 'public'] } },
      }),
    );
  });

  it('rejects an unknown realm or extra keys with 400', async () => {
    const db = fakeDb(undefined);
    const { app } = appFor(DEV_ADMIN, db);
    for (const body of [{ enabled: true, realms: ['root'] }, { enabled: true, realms: [], x: 1 }, { realms: [] }, 'nope']) {
      const res = await app.request('/api/v1/openapi/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('VALIDATION');
    }
    expect(db.insert).not.toHaveBeenCalled();
  });
});
