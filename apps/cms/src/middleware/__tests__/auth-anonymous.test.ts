import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { withAuth } from '../auth';

/**
 * Anonymous (`public` realm) branch of `withAuth`.
 *
 * The invariant under test: a credential-less request stays a 401 unless the
 * site has explicitly enabled public access AND the request is a read on an
 * allow-listed content path. Both conditions are load-bearing, so each is
 * exercised on its own.
 */

/** `publicRoleId` null models a site that has NOT enabled public access. */
function makeFakeDb(publicRoleId: string | null): Database {
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(publicRoleId ? [{ id: publicRoleId }] : []),
  };
  return { select: () => fluent } as unknown as Database;
}

function buildApp(publicRoleId: string | null): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', makeFakeDb(publicRoleId));
    c.set('siteId', 'site_1');
    // No runtime cache: `resolvePublicRoleIdCached` falls back to a direct read.
    await next();
  });
  app.use('*', withAuth());
  app.all('*', (c) => c.json({ auth: c.get('auth') }));
  return app;
}

describe('withAuth anonymous realm', () => {
  it('resolves an unauthenticated read to the public role when enabled', async () => {
    const res = await buildApp('role_public').request('/api/v1/items/articles', {}, {});

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      auth: {
        type: 'anonymous',
        roleId: 'role_public',
        roles: ['role_public'],
        raw: { anonymous: true },
      },
    });
  });

  it('keeps returning 401 when the site has not enabled public access', async () => {
    const res = await buildApp(null).request('/api/v1/items/articles', {}, {});

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      errors: [{ code: 'UNAUTHENTICATED' }],
    });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses %s even on an allow-listed path — anonymous is read-only',
    async (method) => {
      const res = await buildApp('role_public').request(
        '/api/v1/items/articles',
        { method },
        {},
      );
      expect(res.status).toBe(401);
    },
  );

  it.each([
    '/api/v1/collections',
    '/api/v1/users',
    '/api/v1/roles',
    '/api/v1/policies',
    '/api/v1/api-keys',
    '/api/v1/settings',
  ])('refuses a read on the management path %s', async (path) => {
    const res = await buildApp('role_public').request(path, {}, {});
    expect(res.status).toBe(401);
  });

  it.each([
    '/api/v1/items',
    '/api/v1/items/articles/abc',
    '/api/v1/search',
    '/api/v1/media/xyz',
    '/api/v1/files/abc',
  ])('allows a read on the content path %s', async (path) => {
    const res = await buildApp('role_public').request(path, {}, {});
    expect(res.status).toBe(200);
  });

  it('does not match a path that merely shares a prefix string', async () => {
    // `/api/v1/items-admin` must NOT be treated as under `/api/v1/items`.
    const res = await buildApp('role_public').request('/api/v1/items-admin', {}, {});
    expect(res.status).toBe(401);
  });

  it('stays 401 when no tenant has been resolved', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', makeFakeDb('role_public'));
      // siteId deliberately unset.
      await next();
    });
    app.use('*', withAuth());
    app.get('*', (c) => c.json({ auth: c.get('auth') }));

    const res = await app.request('/api/v1/items/articles', {}, {});
    expect(res.status).toBe(401);
  });
});
