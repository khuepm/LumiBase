import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';

/**
 * #990 — an endpoint extension's handler gets the capability-checked ctx and
 * nothing else from the host: no CMS env bindings (secrets), no execution
 * context, no caller credentials. And it sees its own sub-path, wherever the
 * router is mounted.
 */

const h = vi.hoisted(() => ({
  seen: [] as Array<{ path: string; env: unknown; auth: string | null; cookie: string | null; custom: string | null; body: string }>,
}));

vi.mock('../../services/permission-service', () => ({
  PermissionService: vi.fn().mockImplementation(function () {
    return { canAccess: async () => ({ rule: null }) };
  }),
}));

vi.mock('../../extensions/sandbox', () => ({
  ExtensionSandbox: vi.fn().mockImplementation(function () {
    return {
      load: async () => ({
        handler(app: Hono) {
          app.all('*', async (c) => {
            h.seen.push({
              path: new URL(c.req.url).pathname,
              env: c.env,
              auth: c.req.header('authorization') ?? null,
              cookie: c.req.header('cookie') ?? null,
              custom: c.req.header('x-custom') ?? null,
              body: c.req.method === 'GET' ? '' : await c.req.text(),
            });
            return c.json({ ok: true });
          });
        },
      }),
    };
  }),
}));

const { extensionsRouter, extensionSubPath } = await import('../extensions');

function db() {
  const row = { name: 'search', type: 'endpoint', bundleUrl: 'https://ext.example/search.js', capabilities: [], isOfficial: false };
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
  } as unknown as AppEnv['Variables']['db'];
}

function app() {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('auth', { userId: 'usr_admin', roles: ['admin'], raw: {} });
    c.set('siteId', 'site-a');
    c.set('db', db());
    c.set('runtime', { cache: {} } as never);
    await next();
  });
  a.route('/api/v1/extensions', extensionsRouter);
  return a;
}

const SECRET_ENV = { JWT_SECRET: 'super-secret-jwt', DATABASE_URL: 'postgres://u:p@h/db', ENCRYPTION_KEY: 'k' };

beforeEach(() => {
  h.seen.length = 0;
});

describe('endpoint extension dispatch isolation', () => {
  it('never hands the CMS env bindings to the handler', async () => {
    const res = await app().request('/api/v1/extensions/search/ping', {}, SECRET_ENV as never);
    expect(res.status).toBe(200);
    expect(h.seen[0]?.env).toEqual({});
    expect(JSON.stringify(h.seen[0]?.env ?? {})).not.toContain('super-secret-jwt');
  });

  it('strips the caller credentials but keeps other headers and the body', async () => {
    await app().request(
      '/api/v1/extensions/search/index',
      {
        method: 'POST',
        headers: { authorization: 'Bearer user-session-jwt', cookie: 'lumibase_refresh=rt', 'x-custom': 'kept', 'content-type': 'application/json' },
        body: JSON.stringify({ q: 'x' }),
      },
      SECRET_ENV as never,
    );
    expect(h.seen[0]).toMatchObject({ auth: null, cookie: null, custom: 'kept', body: '{"q":"x"}' });
  });

  it('routes to the sub-path under the real mount point', async () => {
    await app().request('/api/v1/extensions/search/admin/reindex?full=1', {}, SECRET_ENV as never);
    expect(h.seen[0]?.path).toBe('/admin/reindex');
  });
});

describe('extensionSubPath', () => {
  it.each([
    ['/api/v1/extensions/search/ping', 'search', '/ping'],
    ['/api/v1/extensions/search/a/b', 'search', '/a/b'],
    ['/api/v1/extensions/search', 'search', '/'],
    ['/extensions/search/x', 'search', '/x'],
    ['/api/v1/extensions/my%20ext/x', 'my ext', '/x'],
    ['/api/v1/extensions/other/x', 'search', '/'],
  ])('%s (%s) → %s', (pathname, name, expected) => {
    expect(extensionSubPath(pathname, name)).toBe(expected);
  });
});
