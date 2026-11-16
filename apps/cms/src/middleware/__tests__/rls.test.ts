import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createSiteScopedSql } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { withRls } from '../rls';

/**
 * `withRls` is an assertion since B130: the scope is applied by `withDb`
 * (`createSiteScopedSql`). These tests pin that it never touches the database
 * and that it fails closed under `LUMIBASE_DB_RLS=enforce` when the request
 * db is not scoped to the request site.
 */
function fakeSql() {
  const calls: unknown[] = [];
  const sql = Object.assign(
    (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve([]);
    },
    {
      unsafe: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve([]);
      },
      begin: async () => {
        calls.push('begin');
        return [];
      },
    },
  );
  return { sql, calls };
}

function buildApp(opts: { siteId: string | undefined; dbClient?: unknown; connection?: unknown }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    if (opts.siteId !== undefined) c.set('siteId', opts.siteId);
    if (opts.dbClient !== undefined) {
      c.set('db', { $client: opts.dbClient } as unknown as AppEnv['Variables']['db']);
    }
    c.set('runtime', {
      database: { getConnection: () => opts.connection },
    } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  app.use('*', withRls());
  app.all('*', (c) => c.json({ ok: true }, 200));
  return app;
}

async function code(res: Response) {
  return ((await res.json()) as { errors: { code: string }[] }).errors[0]?.code;
}

describe('withRls — assertion only (B130)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('flag off: passes through without any database call (round trip dropped)', async () => {
    const { sql, calls } = fakeSql();
    const app = buildApp({ siteId: 'site-a', dbClient: sql, connection: sql });
    const res = await app.request('/anything', {}, { LUMIBASE_ENV: 'production' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('enforce + db scoped to the request site: passes', async () => {
    const { sql, calls } = fakeSql();
    const scoped = createSiteScopedSql(sql as never, 'site-a');
    const app = buildApp({ siteId: 'site-a', dbClient: scoped, connection: sql });
    const res = await app.request('/x', {}, { LUMIBASE_ENV: 'production', LUMIBASE_DB_RLS: 'enforce' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('enforce + unscoped db: 503 RLS_UNAVAILABLE, handler not reached', async () => {
    const { sql } = fakeSql();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({ siteId: 'site-a', dbClient: sql, connection: sql });
    const res = await app.request('/x', {}, { LUMIBASE_ENV: 'production', LUMIBASE_DB_RLS: 'enforce' });
    errSpy.mockRestore();
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('RLS_UNAVAILABLE');
  });

  it('enforce + db scoped to another site: 503 RLS_UNAVAILABLE', async () => {
    const { sql } = fakeSql();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scoped = createSiteScopedSql(sql as never, 'site-b');
    const app = buildApp({ siteId: 'site-a', dbClient: scoped, connection: sql });
    const res = await app.request('/x', {}, { LUMIBASE_ENV: 'production', LUMIBASE_DB_RLS: 'enforce' });
    errSpy.mockRestore();
    expect(res.status).toBe(503);
  });

  it('enforce applies in development too (no dev skip)', async () => {
    const { sql } = fakeSql();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({ siteId: 'site-a', dbClient: sql, connection: sql });
    const res = await app.request('/x', {}, { LUMIBASE_ENV: 'development', LUMIBASE_DB_RLS: 'enforce' });
    errSpy.mockRestore();
    expect(res.status).toBe(503);
  });

  it('invalid flag: 503 RLS_MISCONFIGURED', async () => {
    const { sql } = fakeSql();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({ siteId: 'site-a', dbClient: sql, connection: sql });
    const res = await app.request('/x', {}, { LUMIBASE_ENV: 'production', LUMIBASE_DB_RLS: 'on' });
    errSpy.mockRestore();
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('RLS_MISCONFIGURED');
  });

  it('flag read from process.env when the binding is absent (Docker)', async () => {
    vi.stubEnv('LUMIBASE_DB_RLS', 'enforce');
    const { sql } = fakeSql();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({ siteId: 'site-a', dbClient: sql, connection: sql });
    const res = await app.request('/x', {}, { LUMIBASE_ENV: 'production' });
    errSpy.mockRestore();
    expect(res.status).toBe(503);
  });

  it('no siteId: passes through (nothing to scope)', async () => {
    const { sql } = fakeSql();
    const app = buildApp({ siteId: undefined, dbClient: sql, connection: sql });
    const res = await app.request('/x', {}, { LUMIBASE_ENV: 'production', LUMIBASE_DB_RLS: 'enforce' });
    expect(res.status).toBe(200);
  });
});
