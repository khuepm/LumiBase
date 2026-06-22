import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { insightsRouter } from '../insights';

const DASH = {
  id: 'dash_1',
  siteId: '__default__',
  name: 'Ops',
  icon: null as string | null,
  color: null as string | null,
  note: null as string | null,
  createdBy: null as string | null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

interface Opts {
  dashRows?: (typeof DASH)[];
  inserted?: Record<string, unknown>[];
  updated?: Record<string, unknown>[];
  deleted?: { id: string }[];
}

function fakeDb(opts: Opts): Database {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => Promise.resolve(opts.dashRows ?? []),
    // listing (no .limit) awaits at .where
    then: (res: (v: unknown) => void) => res(opts.dashRows ?? []),
  };
  const insertChain = {
    values: () => insertChain,
    returning: () => Promise.resolve(opts.inserted ?? [{ ...DASH }]),
  };
  const updateChain = {
    set: () => updateChain,
    where: () => updateChain,
    returning: () => Promise.resolve(opts.updated ?? []),
  };
  const deleteChain = {
    where: () => deleteChain,
    returning: () => Promise.resolve(opts.deleted ?? []),
  };
  return {
    select: () => selectChain,
    insert: () => insertChain,
    update: () => updateChain,
    delete: () => deleteChain,
  } as unknown as Database;
}

function buildApp(opts: Opts): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb(opts));
    c.set('siteId', '__default__');
    c.set('auth', { userId: 'u1', roles: [] } as never);
    c.set('runtime', { cache: {} } as never);
    await next();
  });
  app.route('/api/v1/dashboards', insightsRouter);
  return app;
}

describe('POST /api/v1/dashboards', () => {
  it('creates a dashboard', async () => {
    const res = await buildApp({ inserted: [{ ...DASH, name: 'New' }] }).request('/api/v1/dashboards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { name: string } };
    expect(body.data.name).toBe('New');
  });

  it('400s when name is missing', async () => {
    const res = await buildApp({}).request('/api/v1/dashboards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/dashboards/:id', () => {
  it('returns a dashboard in this site', async () => {
    const res = await buildApp({ dashRows: [DASH] }).request('/api/v1/dashboards/dash_1');
    expect(res.status).toBe(200);
  });

  it('404s for a dashboard not in this site', async () => {
    const res = await buildApp({ dashRows: [] }).request('/api/v1/dashboards/other');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/dashboards/:id/panels', () => {
  it('404s when the parent dashboard is absent', async () => {
    const res = await buildApp({ dashRows: [] }).request('/api/v1/dashboards/ghost/panels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'p',
        type: 'metric',
        position: { x: 0, y: 0, w: 4, h: 4 },
        query: { collection: 'orders', aggregate: 'count' },
      }),
    });
    expect(res.status).toBe(404);
  });

  it('400s when the panel query is invalid (non-count without field)', async () => {
    const res = await buildApp({ dashRows: [DASH] }).request('/api/v1/dashboards/dash_1/panels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'p',
        type: 'metric',
        position: { x: 0, y: 0, w: 4, h: 4 },
        query: { collection: 'orders', aggregate: 'sum' }, // missing field
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/v1/dashboards/:id', () => {
  it('204-style 404 when nothing deleted', async () => {
    const res = await buildApp({ deleted: [] }).request('/api/v1/dashboards/ghost', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
