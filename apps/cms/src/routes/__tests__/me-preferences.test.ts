import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { authRouter } from '../auth';

/**
 * Route test for PATCH /api/v1/me/preferences (save-default-preference Req 1, 2,
 * 8). A fluent fake DB records the SET payload so we can assert shallow-merge
 * semantics without a database.
 *
 * **Validates: Requirements 1.2, 2.2, 7.2, 8.2**
 */

function fakeDb(currentPreferences: Record<string, unknown>): { db: Database; lastSet: { value?: Record<string, unknown> } } {
  const lastSet: { value?: Record<string, unknown> } = {};
  const selectFluent = {
    from: () => selectFluent,
    where: () => selectFluent,
    limit: () => Promise.resolve([{ preferences: currentPreferences }]),
  };
  const db = {
    select: () => selectFluent,
    update: () => ({
      set: (payload: { preferences?: Record<string, unknown> }) => {
        lastSet.value = payload.preferences;
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  } as unknown as Database;
  return { db, lastSet };
}

function buildApp(db: Database, userId: string | null = 'usr_1'): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('siteId', 'site_1');
    c.set('auth', { userId, email: 'e@x.dev', roles: ['editor'] } as AppEnv['Variables']['auth']);
    await next();
  });
  app.route('/api/v1/auth', authRouter);
  return app;
}

describe('PATCH /api/v1/auth/me/preferences', () => {
  it('shallow-merges saveAction while preserving existing keys (Req 1.2, 8.2)', async () => {
    const { db, lastSet } = fakeDb({ language: 'vi', theme: 'dark' });
    const res = await buildApp(db).request('/api/v1/auth/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveAction: 'return' }),
    });
    expect(res.status).toBe(200);
    expect(lastSet.value).toEqual({ language: 'vi', theme: 'dark', saveAction: 'return' });
  });

  it('clears the override when saveAction is null (Req 7.2)', async () => {
    const { db, lastSet } = fakeDb({ language: 'vi', saveAction: 'return' });
    await buildApp(db).request('/api/v1/auth/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveAction: null }),
    });
    expect(lastSet.value).toEqual({ language: 'vi' });
    expect(lastSet.value).not.toHaveProperty('saveAction');
  });

  it('rejects an invalid enum with 422 (Req 2.2)', async () => {
    const { db } = fakeDb({});
    const res = await buildApp(db).request('/api/v1/auth/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveAction: 'bogus' }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects an unauthenticated caller with 401', async () => {
    const { db } = fakeDb({});
    const res = await buildApp(db, null).request('/api/v1/auth/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveAction: 'stay' }),
    });
    expect(res.status).toBe(401);
  });
});
