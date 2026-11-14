import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MemoryCacheProvider } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { withTenant } from '../tenant';
import { withAuth } from '../auth';

/**
 * Social login (#736) middleware wiring: the provider callback carries its
 * site in the path (no `X-Lumi-Site` from Google/Apple/GitHub), and the
 * public social routes are reachable without a session. Everything else keeps
 * requiring both.
 */

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('runtime', { cache: new MemoryCacheProvider() } as unknown as AppEnv['Variables']['runtime']);
    c.set('db', { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as unknown as Database);
    await next();
  });
  a.use('*', withTenant(), withAuth());
  a.all('*', (c) => c.json({ siteId: c.get('siteId'), auth: c.get('auth') ?? null }));
  return a;
}

describe('social login paths', () => {
  it('resolves the site from the callback path without a header or session', async () => {
    for (const method of ['GET', 'POST']) {
      const res = await app().request('/api/v1/auth/social/callback/site_abc/apple', { method });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ siteId: 'site_abc', auth: null });
    }
  });

  it('rejects a callback whose path site disagrees with X-Lumi-Site', async () => {
    const res = await app().request('/api/v1/auth/social/callback/site_abc/google', { headers: { 'x-lumi-site': 'site_other' } });
    expect(res.status).toBe(400);
  });

  it('lets start / exchange through withAuth unauthenticated', async () => {
    for (const path of ['/api/v1/auth/social/google/start', '/api/v1/auth/social/exchange', '/api/v1/auth/social/providers']) {
      const res = await app().request(path, { method: 'POST', headers: { 'x-lumi-site': 'site_a' } });
      expect(res.status, path).toBe(200);
    }
  });

  it('still requires a session for /me/identities', async () => {
    const res = await app().request('/api/v1/me/identities', { headers: { 'x-lumi-site': 'site_a' } });
    expect(res.status).not.toBe(200);
  });
});
