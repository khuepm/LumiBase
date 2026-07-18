import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { releasesRouter } from '../releases';

/**
 * Route-wiring + validation tests for /api/v1/releases (Phase C). The create
 * path inserts and returns a row (no ItemService), so a fluent fake DB suffices;
 * publish is covered by release-service.db.integration.test.ts.
 *
 * **Validates: Requirements 1, 4 (route wiring + input validation)**
 */

function fakeDb(insertReturns: unknown[] = [{ id: 'rel_1', status: 'draft', name: 'X' }]): Database {
  const selectFluent = {
    from: () => selectFluent,
    where: () => selectFluent,
    orderBy: () => selectFluent,
    limit: () => selectFluent,
    offset: () => Promise.resolve([]),
    then: (res: (v: unknown) => void) => Promise.resolve([]).then(res),
  };
  return {
    select: () => selectFluent,
    insert: () => ({
      values: () => ({ returning: () => Promise.resolve(insertReturns) }),
    }),
  } as unknown as Database;
}

function buildApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('siteId', 'site_1');
    c.set('auth', { userId: 'usr_1', email: 'e@x.dev', roles: ['admin'], raw: {} } as AppEnv['Variables']['auth']);
    c.set('runtime', {} as AppEnv['Variables']['runtime']);
    await next();
  });
  app.route('/api/v1/releases', releasesRouter);
  return app;
}

describe('POST /api/v1/releases', () => {
  it('creates a draft release (Req 1)', async () => {
    const res = await buildApp(fakeDb()).request('/api/v1/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Spring launch' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe('rel_1');
  });

  it('rejects a missing name with 422 (Req 1)', async () => {
    const res = await buildApp(fakeDb()).request('/api/v1/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'no name' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an invalid targetStatus in addItems (Req 2.5)', async () => {
    const res = await buildApp(fakeDb()).request('/api/v1/releases/rel_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addItems: [{ collection: 'a', itemId: 'i', targetStatus: 'bogus' }] }),
    });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/releases', () => {
  it('lists releases with pagination meta (Req 4.1)', async () => {
    const res = await buildApp(fakeDb()).request('/api/v1/releases');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { page: number; pageSize: number } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.page).toBe(1);
  });
});
