import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { withAuth } from '../auth';

async function signToken(payload: Record<string, unknown>, secret = 'test-secret') {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(new TextEncoder().encode(secret));
}

function makeSelectOnlyDb(selectResults: unknown[][]): Database {
  const queue = [...selectResults];
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve(queue.shift() ?? []),
  };

  return {
    select: () => fluent,
  } as unknown as Database;
}

function buildApp(db: Database, siteId: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('siteId', siteId);
    await next();
  });
  app.use('*', withAuth());
  app.get('/protected', (c) => c.json({ data: c.get('auth') }));
  return app;
}

describe('withAuth custom JWT tenant binding', () => {
  it('rejects a custom JWT when its siteId does not match the selected tenant', async () => {
    const token = await signToken({ userId: 'user-1', email: 'user@example.com', roles: ['member'], siteId: 'site-a' });
    const app = buildApp(makeSelectOnlyDb([[]]), 'site-b');

    const res = await app.request(
      '/protected',
      { headers: { Authorization: `Bearer ${token}` } },
      { JWT_SECRET: 'test-secret' },
    );

    expect(res.status).toBe(401);
  });

  it('rejects a custom JWT for a user who is not a member of the selected tenant', async () => {
    const token = await signToken({ userId: 'user-1', email: 'user@example.com', roles: ['member'], siteId: 'site-a' });
    const app = buildApp(
      makeSelectOnlyDb([
        [],
        [{ id: 'user-1', status: 'active', isBootstrap: false }],
        [],
      ]),
      'site-a',
    );

    const res = await app.request(
      '/protected',
      { headers: { Authorization: `Bearer ${token}` } },
      { JWT_SECRET: 'test-secret' },
    );

    expect(res.status).toBe(401);
  });

  it('accepts a custom JWT only when the token and user membership match the selected tenant', async () => {
    const token = await signToken({ userId: 'user-1', email: 'user@example.com', roles: ['member'], siteId: 'site-a' });
    const app = buildApp(
      makeSelectOnlyDb([
        [],
        [{ id: 'user-1', status: 'active', isBootstrap: false }],
        [{ roleId: 'member' }],
      ]),
      'site-a',
    );

    const res = await app.request(
      '/protected',
      { headers: { Authorization: `Bearer ${token}` } },
      { JWT_SECRET: 'test-secret' },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as { data: { userId: string; roles: string[] } };
    expect(body.data.userId).toBe('user-1');
    expect(body.data.roles).toEqual(['member']);
  });
});
