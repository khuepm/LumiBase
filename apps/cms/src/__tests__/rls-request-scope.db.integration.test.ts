import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@lumibase/database';
import { createSiteScopedSql, MemoryCacheProvider } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import { withDb } from '../middleware/db';
import { withRls } from '../middleware/rls';
import { deliverRouter } from '../routes/deliver';
import { runSiteTransaction } from '../services/rls-transaction';
import { runDueScheduledFlows } from '../services/flow-scheduler';
import { assertDbRlsStartup } from '../config/db-rls-startup';
import { createRlsTestDatabase, type RlsTestDatabase } from '../test-utils/rls-roles';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Request-path RLS scope against a real Postgres (B130, T4,
 * `.kiro/specs/rls-request-scope/` design §7).
 *
 * The suite builds its own throwaway database (the app uses a pool, so the
 * one-transaction-rollback trick of `rls-policies.db.integration.test.ts`
 * cannot work), migrates it, applies `rls-policies.sql` as owner, and creates
 *
 *   - `app`: NOSUPERUSER NOBYPASSRLS — the request role,
 *   - `sys`: NOSUPERUSER BYPASSRLS — the system connection.
 *
 * The REAL `withDb()` + `withRls()` middlewares and the real `deliverRouter`
 * run with `LUMIBASE_DB_RLS=enforce`. Probe routes query RLS tables with NO
 * `site_id` filter, so whatever they see is decided by the database policy
 * alone. The app pool is capped at 2 connections so scoped requests reuse
 * connections and a leaked scope would show up.
 *
 * Mutation check (recorded in the PR): building a plain `drizzle(sql)` in
 * `withDb` under enforce turns the enforce cases red.
 */

const SITE_A = 'rls_site_a';
const SITE_B = 'rls_site_b';
const ENFORCE = { LUMIBASE_ENV: 'test', LUMIBASE_DB_RLS: 'enforce' } as const;
const OFF = { LUMIBASE_ENV: 'test', LUMIBASE_DB_RLS: 'off' } as const;

type Sql = postgres.Sql;

/** Postgres SQLSTATE, also through drizzle's DrizzleQueryError wrapper. */
function pgCode(err: unknown): string | null {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code ?? null;
}

function provider(app: Sql, sys: Sql, hasSystem = true) {
  return {
    getConnection: () => app,
    getSystemConnection: () => (hasSystem ? sys : app),
    hasSystemConnection: () => hasSystem,
    close: async () => {},
  };
}

describe.skipIf(!hasDbIntegrationUrl)('request-path RLS scope (B130) — real Postgres, NOBYPASSRLS app role', () => {
  let fx: RlsTestDatabase;
  let harness: Database;
  let owner: Sql;
  let appSql: Sql;
  let sysSql: Sql;
  let sysDb: Database;
  const pending: Promise<unknown>[] = [];

  function buildApp(opts: { hasSystem?: boolean; presetDb?: Database } = {}) {
    const runtime = {
      runtime: 'docker',
      database: provider(appSql, sysSql, opts.hasSystem ?? true),
      cache: new MemoryCacheProvider(),
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('runtime', runtime as unknown as AppEnv['Variables']['runtime']);
      c.set('requestId', 'rls-test');
      const site = c.req.header('x-lumi-site');
      if (site) c.set('siteId', site);
      if (opts.presetDb) c.set('db', opts.presetDb);
      await next();
    });
    app.use('/api/v1/deliver/*', withDb());
    app.route('/api/v1/deliver', deliverRouter);

    const probe = new Hono<AppEnv>();
    probe.use('*', withDb(), withRls());
    const scope = async (db: Database) =>
      ((await db.execute(sql`SELECT current_setting('app.site_id', true) AS s`)) as unknown as { s: string | null }[])[0]!.s;
    const itemSites = async (db: Database) =>
      ((await db.execute(sql`SELECT site_id FROM lumibase_items ORDER BY site_id`)) as unknown as { site_id: string }[]).map(
        (r) => r.site_id,
      );
    probe.get('/items', async (c) => {
      const db = c.get('db');
      const before = await itemSites(db);
      await new Promise((r) => setTimeout(r, 5));
      const after = await itemSites(db);
      return c.json({ before, after, scope: await scope(db) });
    });
    probe.get('/tx', async (c) => {
      const db = c.get('db');
      const out = await db.transaction(async (tx) => ({
        scope: await scope(tx as unknown as Database),
        sites: await itemSites(tx as unknown as Database),
      }));
      return c.json(out);
    });
    probe.get('/run-site-tx/:to', async (c) => {
      const db = c.get('db');
      const out = await runSiteTransaction(db, c.req.param('to'), async (tx) => ({
        scope: await scope(tx as unknown as Database),
        sites: await itemSites(tx as unknown as Database),
      }));
      return c.json(out);
    });
    probe.post('/items/:target', async (c) => {
      const db = c.get('db');
      try {
        await db.insert(schema.items).values({
          id: `it_${c.req.param('target')}_${Math.random().toString(36).slice(2, 8)}`,
          siteId: c.req.param('target'),
          collectionId: `col_${c.req.param('target')}`,
          data: { title: 'probe' },
        });
        return c.json({ ok: true });
      } catch (err) {
        return c.json({ ok: false, code: pgCode(err) });
      }
    });
    probe.get('/unique-then-continue', async (c) => {
      const db = c.get('db');
      let first: string | null = null;
      try {
        await db.insert(schema.items).values({
          id: 'it_a_1',
          siteId: c.get('siteId'),
          collectionId: `col_${c.get('siteId')}`,
        });
      } catch (err) {
        first = pgCode(err) ?? 'error';
      }
      return c.json({ first, sites: await itemSites(db) });
    });
    probe.get('/fire-and-forget', (c) => {
      const db = c.get('db');
      pending.push(new Promise((r) => setTimeout(r, 20)).then(() => itemSites(db)));
      return c.json({ ok: true });
    });
    app.route('/probe', probe);
    return app;
  }

  const get = (app: Hono<AppEnv>, path: string, site: string | null, env: Record<string, string> = ENFORCE) =>
    app.request(path, { headers: site ? { 'x-lumi-site': site } : {} }, env);

  beforeAll(async () => {
    harness = await connectDbIntegration('rls-request-scope');
    void harness;
    vi.stubEnv('LUMIBASE_ENV', 'test');
    vi.stubEnv('LUMIBASE_DB_RLS', '');
    fx = await createRlsTestDatabase(dbIntegrationUrl!);
    owner = postgres(fx.ownerUrl, { max: 1, prepare: false, onnotice: () => {} });
    appSql = postgres(fx.appUrl, { max: 2, prepare: false });
    sysSql = postgres(fx.sysUrl, { max: 2, prepare: false });
    sysDb = drizzle(sysSql, { schema }) as unknown as Database;

    // Seed through the SYSTEM role: it bypasses RLS, as workers do.
    for (const [site, n] of [
      [SITE_A, 2],
      [SITE_B, 1],
    ] as const) {
      await sysSql`INSERT INTO lumibase_sites (id, name) VALUES (${site}, ${site})`;
      await sysSql`INSERT INTO lumibase_collections (id, site_id, name) VALUES (${`col_${site}`}, ${site}, ${`posts_${site}`})`;
      for (let i = 1; i <= n; i += 1) {
        await sysSql`INSERT INTO lumibase_items (id, site_id, collection_id, status) VALUES (${`it_${site.slice(-1)}_${i}`}, ${site}, ${`col_${site}`}, 'published')`;
      }
      await sysSql`INSERT INTO lumibase_flows (id, site_id, name, status, trigger_type, trigger_options, next_run_at)
        VALUES (${`fl_${site}`}, ${site}, 'sched', 'active', 'schedule', ${JSON.stringify({ cron: '0 0 * * *' })}::jsonb, now() - interval '1 minute')`;
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled(pending);
    await appSql?.end({ timeout: 5 });
    await sysSql?.end({ timeout: 5 });
    await owner?.end({ timeout: 5 });
    await fx?.drop();
    await (harness as unknown as { $client?: Sql })?.$client?.end({ timeout: 5 });
    vi.unstubAllEnvs();
  }, 60_000);

  it('before (flag off, app role): request reads see 0 rows; a standalone set_config scopes nothing', async () => {
    const app = buildApp();
    const res = await get(app, '/probe/items', SITE_A, OFF);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ before: [], after: [], scope: '' });

    await appSql`SELECT set_config('app.site_id', ${SITE_A}, true)`;
    const [row] = await appSql`SELECT current_setting('app.site_id', true) AS s`;
    expect(row!.s).toBe('');
  });

  it('enforce: each site sees exactly its own rows, before and after an await', async () => {
    const app = buildApp();
    const a = (await (await get(app, '/probe/items', SITE_A)).json()) as { before: string[]; after: string[]; scope: string };
    expect(a).toEqual({ before: [SITE_A, SITE_A], after: [SITE_A, SITE_A], scope: SITE_A });
    const b = (await (await get(app, '/probe/items', SITE_B)).json()) as { before: string[]; after: string[] };
    expect(b.before).toEqual([SITE_B]);
    expect(b.after).toEqual([SITE_B]);
  });

  it('enforce: 40 interleaved requests on 2 pooled connections never see the other site', async () => {
    const app = buildApp();
    const sites = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? SITE_A : SITE_B));
    const results = await Promise.all(
      sites.map(async (site) => ({ site, body: (await (await get(app, '/probe/items', site)).json()) as { before: string[]; after: string[]; scope: string } })),
    );
    for (const { site, body } of results) {
      const want = site === SITE_A ? [SITE_A, SITE_A] : [SITE_B];
      expect(body.before, site).toEqual(want);
      expect(body.after, site).toEqual(want);
      expect(body.scope, site).toBe(site);
    }
  });

  it('enforce: the scope never stays on a pooled connection', async () => {
    const app = buildApp();
    await Promise.all([get(app, '/probe/items', SITE_A), get(app, '/probe/items', SITE_B)]);
    const rows = await Promise.all(
      Array.from({ length: 4 }, () => appSql`SELECT current_setting('app.site_id', true) AS s, pg_backend_pid() AS pid`),
    );
    for (const [r] of rows) expect(r!.s ?? '').toBe('');
    const [count] = await appSql`SELECT count(*)::int AS n FROM lumibase_items`;
    expect(count!.n).toBe(0);
  });

  it('enforce: an own-site write lands under that site; a cross-site write is refused by WITH CHECK', async () => {
    const app = buildApp();
    const own = (await (await app.request('/probe/items/' + SITE_A, { method: 'POST', headers: { 'x-lumi-site': SITE_A } }, ENFORCE)).json()) as { ok: boolean };
    expect(own.ok).toBe(true);
    const cross = (await (await app.request('/probe/items/' + SITE_B, { method: 'POST', headers: { 'x-lumi-site': SITE_A } }, ENFORCE)).json()) as { ok: boolean; code: string | null };
    expect(cross).toEqual({ ok: false, code: '42501' });
    const [n] = await sysSql`SELECT count(*)::int AS n FROM lumibase_items WHERE site_id = ${SITE_A} AND data->>'title' = 'probe'`;
    expect(n!.n).toBe(1);
    const [m] = await sysSql`SELECT count(*)::int AS n FROM lumibase_items WHERE site_id = ${SITE_B} AND data->>'title' = 'probe'`;
    expect(m!.n).toBe(0);
    await sysSql`DELETE FROM lumibase_items WHERE data->>'title' = 'probe'`;
  });

  it('enforce: UPDATE row counts survive the wrapper (callers rely on .count)', async () => {
    const scopedA = drizzle(createSiteScopedSql(appSql, SITE_A), { schema }) as unknown as Database;
    const own = (await scopedA
      .update(schema.items)
      .set({ sort: 7 })
      .where(sql`${schema.items.id} = 'it_a_1'`)) as unknown as { count: number };
    expect(own.count).toBe(1);
    const other = (await scopedA
      .update(schema.items)
      .set({ sort: 7 })
      .where(sql`${schema.items.id} = 'it_b_1'`)) as unknown as { count: number };
    expect(other.count).toBe(0);
  });

  it('enforce: db.transaction is scoped; runSiteTransaction re-scopes to another site', async () => {
    const app = buildApp();
    expect(await (await get(app, '/probe/tx', SITE_A)).json()).toEqual({ scope: SITE_A, sites: [SITE_A, SITE_A] });
    expect(await (await get(app, `/probe/run-site-tx/${SITE_B}`, SITE_A)).json()).toEqual({ scope: SITE_B, sites: [SITE_B] });
  });

  it('enforce: a failed statement does not break the next one of the same request', async () => {
    const app = buildApp();
    expect(await (await get(app, '/probe/unique-then-continue', SITE_A)).json()).toEqual({
      first: '23505',
      sites: [SITE_A, SITE_A],
    });
  });

  it('enforce: work that finishes after the response is still scoped', async () => {
    const app = buildApp();
    pending.length = 0;
    expect((await get(app, '/probe/fire-and-forget', SITE_B)).status).toBe(200);
    expect(await Promise.all(pending)).toEqual([[SITE_B]]);
  });

  it('enforce: the public delivery API scopes to the site in the path (no tenant header)', async () => {
    const app = buildApp();
    const b = await (await get(app, `/api/v1/deliver/llms.txt/${SITE_B}`, null)).text();
    expect(b).toContain(`posts_${SITE_B}`);
    expect(b).not.toContain(`posts_${SITE_A}`);

    // Same request with the flag off on the NOBYPASSRLS role: nothing visible.
    const off = await (await get(app, `/api/v1/deliver/llms.txt/${SITE_A}`, null, OFF)).text();
    expect(off).toContain('No public collections yet.');
  });

  it('system connection: cross-site worker sweeps and multi-site inserts work; the app role sees nothing', async () => {
    const appDb = drizzle(appSql, { schema }) as unknown as Database;
    const queue = { enqueue: vi.fn(async () => 'job') };
    expect(await runDueScheduledFlows({ db: appDb, queue } as never)).toBe(0);
    expect(await runDueScheduledFlows({ db: sysDb, queue } as never)).toBe(2);
    expect(queue.enqueue).toHaveBeenCalledTimes(2);

    const multi = (s: Sql) =>
      s`INSERT INTO lumibase_audit_log (id, site_id, event) VALUES (${`au_${Math.random()}`}, ${SITE_A}, 'probe'), (${`au_${Math.random()}`}, ${SITE_B}, 'probe')`;
    await expect(multi(sysSql)).resolves.toBeDefined();
    await expect(multi(appSql)).rejects.toMatchObject({ code: '42501' });
    const [both] = await sysSql`SELECT count(DISTINCT site_id)::int AS n FROM lumibase_audit_log WHERE event = 'probe'`;
    expect(both!.n).toBe(2);
  });

  it('enforce with an unscoped request db fails closed: 503 RLS_UNAVAILABLE', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = buildApp({ presetDb: drizzle(appSql, { schema }) as unknown as Database });
    const res = await get(app, '/probe/items', SITE_A);
    err.mockRestore();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe('RLS_UNAVAILABLE');
  });

  it('enforce without a system connection fails fast (request 503, startup throws)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await get(buildApp({ hasSystem: false }), '/probe/items', SITE_A);
    err.mockRestore();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe('RLS_MISCONFIGURED');

    await expect(
      assertDbRlsStartup({ rawMode: 'enforce', database: provider(appSql, sysSql, true), log: () => {} }),
    ).resolves.toBe('enforce');
    await expect(
      assertDbRlsStartup({ rawMode: 'enforce', database: provider(appSql, appSql, true) }),
    ).rejects.toThrow(/BYPASSRLS/);
    await expect(
      assertDbRlsStartup({ rawMode: 'enforce', database: provider(appSql, sysSql, false) }),
    ).rejects.toThrow(/DATABASE_SYSTEM_URL/);
  });
});
