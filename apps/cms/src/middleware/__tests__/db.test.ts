import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import { isSiteScopedSql, scopedSiteIdOf, unscopedSqlOf } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { dbClientOf, scopedDbFor, systemDbFor, withDb, withSystemDb } from '../db';

/**
 * `withDb` / `withSystemDb` / `scopedDbFor` / `systemDbFor` (B130). A fake
 * runtime returns recording fake postgres.js clients; nothing connects.
 */
function fakeSql(name: string) {
  const sql = Object.assign(() => Promise.resolve([]), {
    label: name,
    options: { parsers: {}, serializers: {} },
    unsafe: () => Promise.resolve([]),
    begin: async () => [],
  });
  return sql;
}

function fakeRuntime(opts: { system?: boolean } = {}) {
  const app = fakeSql('app');
  const sys = opts.system ? fakeSql('sys') : app;
  return {
    app,
    sys,
    runtime: {
      database: {
        getConnection: () => app,
        getSystemConnection: () => sys,
        hasSystemConnection: () => Boolean(opts.system),
      },
    },
  };
}

interface Seen {
  db?: Database;
  systemDb?: Database;
  scoped?: Database;
  scopedAgain?: Database;
  error?: string;
}

function buildApp(opts: {
  runtime: unknown;
  siteId?: string;
  presetDb?: Database;
  mw?: 'db' | 'system';
  probe?: (c: Context<AppEnv>, seen: Seen) => void;
}) {
  const seen: Seen = {};
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('runtime', opts.runtime as AppEnv['Variables']['runtime']);
    if (opts.siteId) c.set('siteId', opts.siteId);
    if (opts.presetDb) c.set('db', opts.presetDb);
    await next();
  });
  app.use('*', opts.mw === 'system' ? withSystemDb() : withDb());
  app.get('*', (c) => {
    seen.db = c.get('db');
    try {
      opts.probe?.(c, seen);
    } catch (err) {
      seen.error = (err as Error).message;
    }
    return c.json({ ok: true });
  });
  return { app, seen };
}

const PROD = { LUMIBASE_ENV: 'production' };
const ENFORCE = { LUMIBASE_ENV: 'production', LUMIBASE_DB_RLS: 'enforce' };

describe('withDb (B130)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('flag off: plain drizzle over the raw app connection', async () => {
    const { runtime, app: appSql } = fakeRuntime();
    const { app, seen } = buildApp({ runtime, siteId: 'site-a' });
    expect((await app.request('/', {}, PROD)).status).toBe(200);
    expect(dbClientOf(seen.db)).toBe(appSql);
    expect(isSiteScopedSql(dbClientOf(seen.db))).toBe(false);
  });

  it('enforce + siteId: the db is scoped to that site over the app connection', async () => {
    const { runtime, app: appSql } = fakeRuntime({ system: true });
    const { app, seen } = buildApp({ runtime, siteId: 'site-a' });
    expect((await app.request('/', {}, ENFORCE)).status).toBe(200);
    expect(isSiteScopedSql(dbClientOf(seen.db))).toBe(true);
    expect(scopedSiteIdOf(dbClientOf(seen.db))).toBe('site-a');
    expect(unscopedSqlOf(dbClientOf(seen.db))).toBe(appSql);
  });

  it('enforce without siteId: unscoped app db (fails closed on RLS tables by itself)', async () => {
    const { runtime, app: appSql } = fakeRuntime({ system: true });
    const { app, seen } = buildApp({ runtime });
    expect((await app.request('/', {}, ENFORCE)).status).toBe(200);
    expect(dbClientOf(seen.db)).toBe(appSql);
  });

  it('enforce without a system connection: 503 RLS_MISCONFIGURED', async () => {
    const { runtime } = fakeRuntime();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = buildApp({ runtime, siteId: 'site-a' });
    const res = await app.request('/', {}, ENFORCE);
    err.mockRestore();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe('RLS_MISCONFIGURED');
  });

  it('invalid flag: 503 RLS_MISCONFIGURED', async () => {
    const { runtime } = fakeRuntime({ system: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = buildApp({ runtime, siteId: 'site-a' });
    const res = await app.request('/', {}, { LUMIBASE_ENV: 'production', LUMIBASE_DB_RLS: 'yes' });
    err.mockRestore();
    expect(res.status).toBe(503);
  });

  it('respects a db already set on the context', async () => {
    const { runtime } = fakeRuntime({ system: true });
    const preset = { $client: fakeSql('preset') } as unknown as Database;
    const { app, seen } = buildApp({ runtime, siteId: 'site-a', presetDb: preset });
    expect((await app.request('/', {}, ENFORCE)).status).toBe(200);
    expect(seen.db).toBe(preset);
  });
});

describe('withSystemDb (B130)', () => {
  it('sets the system connection as c.get("db") and c.get("systemDb")', async () => {
    const { runtime, sys } = fakeRuntime({ system: true });
    const { app, seen } = buildApp({
      runtime,
      siteId: 'site-a',
      mw: 'system',
      probe: (c, s) => {
        s.systemDb = c.get('systemDb');
      },
    });
    expect((await app.request('/', {}, ENFORCE)).status).toBe(200);
    expect(dbClientOf(seen.db)).toBe(sys);
    expect(seen.systemDb).toBe(seen.db);
  });

  it('enforce without a system connection: 503 RLS_MISCONFIGURED', async () => {
    const { runtime } = fakeRuntime();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = buildApp({ runtime, mw: 'system' });
    const res = await app.request('/', {}, ENFORCE);
    err.mockRestore();
    expect(res.status).toBe(503);
  });

  it('flag off without a system connection: fine, uses the main connection', async () => {
    const { runtime, app: appSql } = fakeRuntime();
    const { app, seen } = buildApp({ runtime, mw: 'system' });
    expect((await app.request('/', {}, PROD)).status).toBe(200);
    expect(dbClientOf(seen.db)).toBe(appSql);
  });
});

describe('scopedDbFor / systemDbFor (B130)', () => {
  it('flag off: scopedDbFor returns c.get("db") unchanged', async () => {
    const { runtime } = fakeRuntime();
    const { app, seen } = buildApp({
      runtime,
      probe: (c, s) => {
        s.scoped = scopedDbFor(c, 'site-b');
      },
    });
    await app.request('/', {}, PROD);
    expect(seen.scoped).toBe(seen.db);
  });

  it('enforce: scopedDbFor scopes the app connection to the given site, memoised', async () => {
    const { runtime, app: appSql } = fakeRuntime({ system: true });
    const { app, seen } = buildApp({
      runtime,
      probe: (c, s) => {
        s.scoped = scopedDbFor(c, 'site-b');
        s.scopedAgain = scopedDbFor(c, 'site-b');
      },
    });
    await app.request('/', {}, ENFORCE);
    expect(scopedSiteIdOf(dbClientOf(seen.scoped))).toBe('site-b');
    expect(unscopedSqlOf(dbClientOf(seen.scoped))).toBe(appSql);
    expect(seen.scopedAgain).toBe(seen.scoped);
  });

  it('enforce: scopedDbFor for the request site returns the request db', async () => {
    const { runtime } = fakeRuntime({ system: true });
    const { app, seen } = buildApp({
      runtime,
      siteId: 'site-a',
      probe: (c, s) => {
        s.scoped = scopedDbFor(c, 'site-a');
      },
    });
    await app.request('/', {}, ENFORCE);
    expect(seen.scoped).toBe(seen.db);
  });

  it('enforce: re-scoping a site-A request to site B uses the raw app connection', async () => {
    const { runtime, app: appSql } = fakeRuntime({ system: true });
    const { app, seen } = buildApp({
      runtime,
      siteId: 'site-a',
      probe: (c, s) => {
        s.scoped = scopedDbFor(c, 'site-b');
      },
    });
    await app.request('/', {}, ENFORCE);
    expect(scopedSiteIdOf(dbClientOf(seen.scoped))).toBe('site-b');
    expect(unscopedSqlOf(dbClientOf(seen.scoped))).toBe(appSql);
  });

  it('systemDbFor picks the system connection and memoises it', async () => {
    const { runtime, sys } = fakeRuntime({ system: true });
    const { app, seen } = buildApp({
      runtime,
      siteId: 'site-a',
      probe: (c, s) => {
        s.systemDb = systemDbFor(c);
        s.scopedAgain = systemDbFor(c);
      },
    });
    await app.request('/', {}, ENFORCE);
    expect(dbClientOf(seen.systemDb)).toBe(sys);
    expect(seen.scopedAgain).toBe(seen.systemDb);
  });

  it('flag off without a system connection: systemDbFor reuses the request db', async () => {
    const { runtime } = fakeRuntime();
    const { app, seen } = buildApp({
      runtime,
      siteId: 'site-a',
      probe: (c, s) => {
        s.systemDb = systemDbFor(c);
      },
    });
    await app.request('/', {}, PROD);
    expect(seen.systemDb).toBe(seen.db);
  });

  it('scopedDbFor without withDb throws', () => {
    const c = { get: () => undefined, env: {} } as unknown as Context<AppEnv>;
    expect(() => scopedDbFor(c, 'site-a')).toThrow(/withDb/);
  });
});
