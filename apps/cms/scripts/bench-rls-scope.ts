#!/usr/bin/env tsx
/**
 * Cost of the request-path RLS scope (B130, `.kiro/specs/rls-request-scope/`
 * design §9). Local measurement only — not representative of Hyperdrive.
 *
 *   DATABASE_URL=postgresql://postgres:…@localhost:55473/postgres \
 *     pnpm -F @lumibase/cms exec tsx scripts/bench-rls-scope.ts
 *
 * Builds a throwaway database with `src/test-utils/rls-roles.ts` (migrations +
 * `rls-policies.sql`, app role NOBYPASSRLS, system role BYPASSRLS), seeds
 * 2 sites × 200 items, and mounts the REAL `withDb()` + `withRls()` in front of
 * a handler that lists 50 items of the request site. It compares:
 *
 *   off     — LUMIBASE_DB_RLS=off on the BYPASSRLS role (today's working setup)
 *   enforce — LUMIBASE_DB_RLS=enforce on the NOBYPASSRLS app role
 *
 * Loads: N sequential requests, then N requests at concurrency C. Prints
 * p50/p95/mean latency and statements per request (postgres.js `debug` hook).
 * The database and roles are dropped at the end.
 */
import { Hono } from 'hono';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { schema } from '@lumibase/database';
import type { AppEnv } from '../src/env';
import { withDb } from '../src/middleware/db';
import { withRls } from '../src/middleware/rls';
import { createRlsTestDatabase } from '../src/test-utils/rls-roles';

const N = Number(process.env.BENCH_N ?? 1000);
const C = Number(process.env.BENCH_CONCURRENCY ?? 20);
const SITES = ['bench_site_a', 'bench_site_b'];

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { p50: pct(s, 50), p95: pct(s, 95), mean };
}

async function main() {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL (a superuser on a throwaway server) is required');
  process.env.LUMIBASE_ENV = 'test';
  const fx = await createRlsTestDatabase(adminUrl);
  let statements = 0;
  const debug = () => {
    statements += 1;
  };
  const appSql = postgres(fx.appUrl, { max: 10, prepare: false, debug });
  const sysSql = postgres(fx.sysUrl, { max: 10, prepare: false, debug });
  try {
    for (const site of SITES) {
      await sysSql`INSERT INTO lumibase_sites (id, name) VALUES (${site}, ${site})`;
      await sysSql`INSERT INTO lumibase_collections (id, site_id, name) VALUES (${`col_${site}`}, ${site}, 'posts')`;
      const rows = Array.from({ length: 200 }, (_, i) => ({
        id: `${site}_it_${i}`,
        site_id: site,
        collection_id: `col_${site}`,
        status: 'published',
      }));
      await sysSql`INSERT INTO lumibase_items ${sysSql(rows)}`;
    }

    const build = (app: postgres.Sql, sys: postgres.Sql) => {
      const runtime = {
        database: {
          getConnection: () => app,
          getSystemConnection: () => sys,
          hasSystemConnection: () => true,
          close: async () => {},
        },
      };
      const h = new Hono<AppEnv>();
      h.use('*', async (c, next) => {
        c.set('runtime', runtime as unknown as AppEnv['Variables']['runtime']);
        c.set('siteId', c.req.header('x-lumi-site')!);
        await next();
      });
      h.use('*', withDb(), withRls());
      h.get('/items', async (c) => {
        const rows = await c
          .get('db')
          .select({ id: schema.items.id, siteId: schema.items.siteId })
          .from(schema.items)
          .where(and(eq(schema.items.siteId, c.get('siteId')), eq(schema.items.collectionId, `col_${c.get('siteId')}`)))
          .limit(50);
        return c.json({ data: rows });
      });
      return h;
    };

    const modes = [
      { name: 'off (BYPASSRLS role)', app: build(sysSql, sysSql), env: { LUMIBASE_ENV: 'test', LUMIBASE_DB_RLS: 'off' } },
      { name: 'enforce (NOBYPASSRLS app role)', app: build(appSql, sysSql), env: { LUMIBASE_ENV: 'test', LUMIBASE_DB_RLS: 'enforce' } },
    ];

    const one = async (app: Hono<AppEnv>, env: Record<string, string>, i: number) => {
      const site = SITES[i % 2]!;
      const t0 = performance.now();
      const res = await app.request('/items', { headers: { 'x-lumi-site': site } }, env);
      const body = (await res.json()) as { data: { siteId: string }[] };
      const dt = performance.now() - t0;
      if (res.status !== 200 || body.data.length !== 50 || body.data.some((r) => r.siteId !== site)) {
        throw new Error(`bad response ${res.status} (${body.data?.length} rows)`);
      }
      return dt;
    };

    const out: Record<string, unknown>[] = [];
    for (const m of modes) {
      // warm-up
      for (let i = 0; i < 50; i += 1) await one(m.app, m.env, i);

      statements = 0;
      const seq: number[] = [];
      for (let i = 0; i < N; i += 1) seq.push(await one(m.app, m.env, i));
      const seqStatements = statements / N;

      statements = 0;
      const conc: number[] = [];
      let next = 0;
      const tStart = performance.now();
      await Promise.all(
        Array.from({ length: C }, async () => {
          while (next < N) {
            const i = next++;
            conc.push(await one(m.app, m.env, i));
          }
        }),
      );
      const wall = performance.now() - tStart;
      out.push({
        mode: m.name,
        sequential: { ...stats(seq), statementsPerRequest: seqStatements },
        concurrent: { ...stats(conc), concurrency: C, throughputRps: (N / wall) * 1000, statementsPerRequest: statements / N },
      });
    }

    const fmt = (n: number) => n.toFixed(2);
    console.log(`bench-rls-scope: N=${N}, concurrency=${C}, postgres ${(await sysSql`SHOW server_version`)[0]!.server_version}`);
    for (const r of out as Array<{ mode: string; sequential: ReturnType<typeof stats> & { statementsPerRequest: number }; concurrent: ReturnType<typeof stats> & { throughputRps: number; statementsPerRequest: number } }>) {
      console.log(
        `${r.mode.padEnd(32)} sequential p50=${fmt(r.sequential.p50)}ms p95=${fmt(r.sequential.p95)}ms mean=${fmt(r.sequential.mean)}ms stmts/req=${fmt(r.sequential.statementsPerRequest)} | ` +
          `concurrent(${C}) p50=${fmt(r.concurrent.p50)}ms p95=${fmt(r.concurrent.p95)}ms mean=${fmt(r.concurrent.mean)}ms rps=${fmt(r.concurrent.throughputRps)} stmts/req=${fmt(r.concurrent.statementsPerRequest)}`,
      );
    }
    console.log(JSON.stringify(out));
  } finally {
    await appSql.end({ timeout: 5 });
    await sysSql.end({ timeout: 5 });
    await fx.drop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
