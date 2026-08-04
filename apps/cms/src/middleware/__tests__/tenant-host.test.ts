import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { CacheProvider } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { withTenant } from '../tenant';

/** Minimal in-memory CacheProvider for the tenant lookup. */
function makeCache(seed: Record<string, string> = {}): CacheProvider {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    get: async <T = string>(key: string) => (store.get(key) ?? null) as T | null,
    getEntry: async <T>(key: string) => {
      const raw = store.get(key);
      if (raw === undefined) return { state: 'miss' as const };
      return { state: 'hit' as const, value: raw as T };
    },
    set: async (key, value) => void store.set(key, value),
    setNegative: async (key) => {
      store.set(key, JSON.stringify({ __lumi: 'neg', v: 1 }));
    },
    delete: async (key) => void store.delete(key),
    invalidateByTag: async () => undefined,
    increment: async (key, by = 1) => {
      const next = Number(store.get(key) ?? '0') + by;
      store.set(key, String(next));
      return next;
    },
  };
}

function buildApp(cache: CacheProvider): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    // Stub the runtime so `c.get('runtime').cache` resolves.
    c.set('runtime', { cache } as AppEnv['Variables']['runtime']);
    await next();
  });
  app.use('*', withTenant());
  app.get('/api/v1/ping', (c) => c.json({ siteId: c.get('siteId') }));
  return app;
}

describe('withTenant — host resolution', () => {
  it('resolves a custom domain via the site-host KV mapping', async () => {
    const app = buildApp(makeCache({ 'site-host:cms.acme.com': 'site-acme' }));
    const res = await app.request('/api/v1/ping', { headers: { host: 'cms.acme.com' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ siteId: 'site-acme' });
  });

  it('resolves a free subdomain via its full host (not just the first label)', async () => {
    const app = buildApp(makeCache({ 'site-host:acme.lumibase.dev': 'site-acme' }));
    const res = await app.request('/api/v1/ping', { headers: { host: 'acme.lumibase.dev' } });
    expect(await res.json()).toEqual({ siteId: 'site-acme' });
  });

  it('strips the port from the Host header before lookup', async () => {
    const app = buildApp(makeCache({ 'site-host:acme.com': 'site-acme' }));
    const res = await app.request('/api/v1/ping', { headers: { host: 'acme.com:8787' } });
    expect(await res.json()).toEqual({ siteId: 'site-acme' });
  });

  it('prefers the X-Lumi-Site header over any host mapping', async () => {
    const app = buildApp(makeCache({ 'site-host:acme.com': 'site-acme' }));
    const res = await app.request('/api/v1/ping', {
      headers: { host: 'acme.com', 'x-lumi-site': 'site-header' },
    });
    expect(await res.json()).toEqual({ siteId: 'site-header' });
  });

  it('falls back to the legacy subdomain mapping when no exact host match', async () => {
    const app = buildApp(makeCache({ 'site-domain:blog': 'site-blog' }));
    const res = await app.request('/api/v1/ping', { headers: { host: 'blog.api.lumibase.dev' } });
    expect(await res.json()).toEqual({ siteId: 'site-blog' });
  });

  it('returns TENANT_REQUIRED when nothing resolves', async () => {
    const app = buildApp(makeCache());
    const res = await app.request(
      '/api/v1/ping',
      { headers: { host: 'unknown.example.com' } },
      { LUMIBASE_DEV_AUTH: 'false' },
    );
    expect(res.status).toBe(400);
  });
});
