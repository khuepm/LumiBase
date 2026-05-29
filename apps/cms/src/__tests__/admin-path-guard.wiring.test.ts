import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../env';
import { withLogger } from '../middleware/logger';
import {
  __resetAdminPathGuardCacheForTests,
  adminPathGuard,
} from '../middleware/admin-path-guard';

/**
 * Wiring tests for the Admin Path Guard middleware mount in
 * `apps/cms/src/index.ts` (admin-setup-wizard task 4.3; Req 5.3, 5.4;
 * design §6.2).
 *
 * Two complementary checks:
 *
 *   1. **Mount-order assertion against `index.ts`**: a source-level
 *      regex assertion that `adminPathGuard()` is mounted after the
 *      global `withRuntime()` (so the guard can resolve a per-request
 *      DB) and before the first `app.route(...)` (so a probing bot
 *      gets the indistinguishable 404 before any route handler runs).
 *      Looking at the file source is intentional — actually fetching
 *      against the real `app` from `index.ts` would trigger
 *      `withRuntime` and try to open a Redis/Postgres connection,
 *      which is not viable in unit-test contexts.
 *
 *   2. **End-to-end behaviour through a stand-in chain** that mirrors
 *      the global stack from `index.ts` (`withLogger` → DB stub →
 *      `adminPathGuard`) plus a representative `app.route(...)`.
 *      This proves the guard, when mounted in this exact order, both
 *      lets `/api/*` traffic through to the routed handler and
 *      returns the canonical 404 envelope for default bait paths
 *      while initialised. The real `index.ts` mounts the guard the
 *      same way; combined with the source assertion above this gives
 *      practical confidence that requests flow as designed without
 *      booting the full runtime.
 */

// ── DB fake ─────────────────────────────────────────────────────────────

interface FakeDbState {
  state: 'uninitialized' | 'initializing' | 'initialized';
  adminPath: string | null;
}

function makeFakeDb(initial: FakeDbState): Database {
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () =>
      Promise.resolve([{ state: initial.state, adminPath: initial.adminPath }]),
  };
  return {
    select: () => fluent,
    execute: () => Promise.resolve(undefined),
  } as unknown as Database;
}

beforeEach(() => {
  __resetAdminPathGuardCacheForTests();
});

// ── 1. Mount-order assertion ────────────────────────────────────────────

describe('adminPathGuard wiring — index.ts source order', () => {
  const indexPath = resolve(__dirname, '..', 'index.ts');
  const source = readFileSync(indexPath, 'utf8');

  it('imports adminPathGuard from the middleware barrel', () => {
    expect(source).toMatch(
      /import\s*\{\s*adminPathGuard\s*\}\s*from\s*['"]\.\/middleware\/admin-path-guard['"]/,
    );
  });

  it('mounts adminPathGuard() globally with app.use', () => {
    expect(source).toMatch(/app\.use\(['"]\*['"],\s*adminPathGuard\(\)\)/);
  });

  it('mounts adminPathGuard after withRuntime (so it can read system_state)', () => {
    const withRuntimeIdx = source.indexOf("app.use('*', withRuntime())");
    const guardIdx = source.indexOf("app.use('*', adminPathGuard())");
    expect(withRuntimeIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(withRuntimeIdx);
  });

  it('mounts adminPathGuard before the first app.route(...) call', () => {
    const guardIdx = source.indexOf("app.use('*', adminPathGuard())");
    const firstRouteIdx = source.search(/\bapp\.route\s*\(/);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(firstRouteIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(firstRouteIdx);
  });
});

// ── 2. Behavioural check over the same chain ────────────────────────────

/**
 * Build a Hono app whose global middleware order mirrors the
 * production `index.ts`: `withLogger` → (stubbed runtime/db) →
 * `adminPathGuard` → routed handlers. We swap the production
 * `withRuntime` for an inline stub that exposes the fake DB on
 * `c.set('db', ...)` so the guard finds the connection without
 * touching Redis or postgres-js.
 */
function buildStandinApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', withLogger());
  // Production has withMetrics + withRuntime here; for the wiring test
  // we just need *something* that places the DB on the context before
  // the guard runs, matching the design §6.2 ordering.
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  app.use('*', adminPathGuard());

  // Stand-in routes — same shapes used in index.ts.
  app.route(
    '/api/v1/setup',
    new Hono<AppEnv>().get('/state', (c) =>
      c.json({ state: 'uninitialized', requiresSetupToken: false }),
    ),
  );
  app.route(
    '/health',
    new Hono<AppEnv>().get('/', (c) => c.json({ ok: true })),
  );
  // Catch-all for anything that escaped the guard (Studio HTML route
  // would land here in production).
  app.all('*', (c) => c.json({ ok: true, tag: c.get('responseType') ?? null }));
  return app;
}

describe('adminPathGuard wiring — behaviour through the global chain', () => {
  it("lets /api/v1/setup/state through while state='uninitialized' (Req 5.4)", async () => {
    const app = buildStandinApp(
      makeFakeDb({ state: 'uninitialized', adminPath: null }),
    );
    const res = await app.request('/api/v1/setup/state');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe('uninitialized');
  });

  it("lets /health through under all states (ops surface bypass)", async () => {
    const app = buildStandinApp(
      makeFakeDb({ state: 'initialized', adminPath: '/lumi-7f3a9c' }),
    );
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it("lets the wizard surface through while uninitialized (Req 5.4)", async () => {
    const app = buildStandinApp(
      makeFakeDb({ state: 'uninitialized', adminPath: null }),
    );
    // /admin, while uninitialized, must NOT 404 — operator might be
    // mid-bootstrap and the guard must stay out of the way.
    const res = await app.request('/admin');
    expect(res.status).toBe(200);
  });

  it("returns the indistinguishable 404 envelope for default bait paths once initialised (Req 5.3)", async () => {
    const app = buildStandinApp(
      makeFakeDb({ state: 'initialized', adminPath: '/lumi-7f3a9c' }),
    );
    const res = await app.request('/admin');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ errors: [{ code: 'NOT_FOUND' }] });
  });

  it("serves the configured admin path with STUDIO_HTML tag once initialised", async () => {
    const app = buildStandinApp(
      makeFakeDb({ state: 'initialized', adminPath: '/lumi-7f3a9c' }),
    );
    const res = await app.request('/lumi-7f3a9c');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tag: string | null };
    expect(body.tag).toBe('STUDIO_HTML');
  });
});
