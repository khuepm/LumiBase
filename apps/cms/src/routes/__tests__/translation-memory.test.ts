import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { tmRouter } from '../translation-memory';

const ENTRY = {
  id: 'tm_1',
  siteId: '__default__',
  sourceLang: 'en',
  targetLang: 'vi',
  sourceText: 'Hello',
  targetText: 'Xin chào',
  context: null as string | null,
  quality: 100,
  source: 'human',
  provider: null as string | null,
  hits: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

interface FakeDbOptions {
  /** Rows returned by the list SELECT. */
  rows?: (typeof ENTRY)[];
  /** Total count returned by the count SELECT. */
  total?: number;
  /** Rows returned by UPDATE … RETURNING (empty → 404). */
  updated?: (typeof ENTRY)[];
  /** Rows returned by DELETE … RETURNING (empty → 404). */
  deleted?: (typeof ENTRY)[];
  /** Captures the SET payload passed to UPDATE. */
  captured?: { set?: Record<string, unknown> };
}

function fakeDb(opts: FakeDbOptions): Database {
  // Two SELECT shapes are used by GET /tm: a row list (.limit().offset())
  // and a count (.where() resolving to [{ value }]). A single chain object
  // serves both by being awaitable at either terminal.
  let selectCall = 0;
  const listChain = {
    from: () => listChain,
    where: () => listChain,
    limit: () => listChain,
    offset: () => Promise.resolve(opts.rows ?? []),
  };
  const countChain = {
    from: () => countChain,
    where: () => Promise.resolve([{ value: opts.total ?? (opts.rows?.length ?? 0) }]),
  };
  const updateChain = {
    set: (payload: Record<string, unknown>) => {
      if (opts.captured) opts.captured.set = payload;
      return updateChain;
    },
    where: () => updateChain,
    returning: () => Promise.resolve(opts.updated ?? []),
  };
  const deleteChain = {
    where: () => deleteChain,
    returning: () => Promise.resolve(opts.deleted ?? []),
  };
  return {
    select: () => {
      // First select in GET is the list, second is the count.
      selectCall += 1;
      return selectCall % 2 === 1 ? listChain : countChain;
    },
    update: () => updateChain,
    delete: () => deleteChain,
  } as unknown as Database;
}

function buildApp(opts: FakeDbOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', fakeDb(opts));
    c.set('siteId', '__default__');
    await next();
  });
  app.route('/api/v1/tm', tmRouter);
  return app;
}

describe('GET /api/v1/tm (pagination)', () => {
  it('returns rows with pagination meta', async () => {
    const res = await buildApp({ rows: [ENTRY], total: 42 }).request('/api/v1/tm?limit=10&offset=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; meta: { total: number; limit: number; offset: number } };
    expect(body.data).toHaveLength(1);
    expect(body.meta.total).toBe(42);
    expect(body.meta.limit).toBe(10);
    expect(body.meta.offset).toBe(0);
  });

  it('clamps limit to the 1..200 range', async () => {
    const res = await buildApp({ rows: [], total: 0 }).request('/api/v1/tm?limit=9999');
    const body = (await res.json()) as { meta: { limit: number } };
    expect(body.meta.limit).toBe(200);
  });
});

describe('PATCH /api/v1/tm/:id', () => {
  it('updates fields and stamps updatedAt', async () => {
    const captured: { set?: Record<string, unknown> } = {};
    const res = await buildApp({ captured, updated: [{ ...ENTRY, targetText: 'Chào' }] }).request(
      '/api/v1/tm/tm_1',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetText: 'Chào', quality: 90 }),
      },
    );
    expect(res.status).toBe(200);
    expect(captured.set?.targetText).toBe('Chào');
    expect(captured.set?.quality).toBe(90);
    expect(captured.set?.updatedAt).toBeInstanceOf(Date);
  });

  it('404s when the entry is not found in this site', async () => {
    const res = await buildApp({ updated: [] }).request('/api/v1/tm/missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetText: 'x' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s on an invalid quality', async () => {
    const res = await buildApp({}).request('/api/v1/tm/tm_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quality: 500 }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/v1/tm/:id', () => {
  it('deletes an existing entry', async () => {
    const res = await buildApp({ deleted: [ENTRY] }).request('/api/v1/tm/tm_1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe('tm_1');
  });

  it('404s when nothing is deleted (wrong site or missing id)', async () => {
    const res = await buildApp({ deleted: [] }).request('/api/v1/tm/missing', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
