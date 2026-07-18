import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import {
  __resetAdminPathGuardCacheForTests,
  adminPathGuard,
  isStudioScopePath,
  pathMatchesAdminScope,
} from '../admin-path-guard';

/**
 * Unit tests for the Admin Path Guard middleware (admin-setup-wizard
 * task 4.2; Req 5.1, 5.2, 5.4, 5.6, 5.7; design §6.2 + §7.2).
 *
 * The tests focus on the routing decisions and on the response shape
 * of the indistinguishable 404. The DB layer is stubbed via a tiny
 * fake `Database` that records calls — we don't need a real Postgres
 * to exercise the bypass-vs-404 branches.
 */

// ── DB fake ─────────────────────────────────────────────────────────────

interface FakeDbState {
  state: 'uninitialized' | 'initializing' | 'initialized';
  adminPath: string | null;
  selectCount: number;
  noopCount: number;
  failOnSelect?: boolean;
}

function makeFakeDb(initial: Partial<FakeDbState>): {
  db: Database;
  state: FakeDbState;
} {
  const state: FakeDbState = {
    state: initial.state ?? 'uninitialized',
    adminPath: initial.adminPath ?? null,
    selectCount: 0,
    noopCount: 0,
    failOnSelect: initial.failOnSelect ?? false,
  };

  // Mimic just enough of the Drizzle fluent surface that the guard
  // exercises: `db.select({...}).from(table).where(...).limit(1)` and
  // `db.execute(sql)` for the SELECT 1 no-op.
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => {
      state.selectCount += 1;
      if (state.failOnSelect) {
        return Promise.reject(new Error('forced db failure'));
      }
      return Promise.resolve([
        { state: state.state, adminPath: state.adminPath },
      ]);
    },
  };

  const db = {
    select: () => fluent,
    execute: () => {
      state.noopCount += 1;
      return Promise.resolve(undefined);
    },
  } as unknown as Database;

  return { db, state };
}

// ── helpers ─────────────────────────────────────────────────────────────

function buildApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Stub a `db` getter so the guard's `c.get('db')` branch is what we
  // exercise. This keeps the test off the runtime adapter and away
  // from drizzle-orm/postgres-js construction.
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  app.use('*', adminPathGuard());
  // Pass-through "next" handler — when the guard calls `next()`, this
  // returns 200 + body so the test can distinguish bypass from 404.
  app.all('*', (c) => {
    const tag = c.get('responseType');
    return c.json({ ok: true, tag: tag ?? null }, 200);
  });
  return app;
}

beforeEach(() => {
  __resetAdminPathGuardCacheForTests();
});

// ── pure helpers ───────────────────────────────────────────────────────

describe('isStudioScopePath', () => {
  it('treats /api/* as not Studio scope', () => {
    expect(isStudioScopePath('/api/v1/users')).toBe(false);
    expect(isStudioScopePath('/api/v1/setup/state')).toBe(false);
    expect(isStudioScopePath('/api/v1/auth/login')).toBe(false);
  });

  it('treats ops/health/metrics/scim/setup as not Studio scope', () => {
    expect(isStudioScopePath('/health')).toBe(false);
    expect(isStudioScopePath('/health/db')).toBe(false);
    expect(isStudioScopePath('/metrics')).toBe(false);
    expect(isStudioScopePath('/scim/v2/Users')).toBe(false);
    expect(isStudioScopePath('/setup')).toBe(false);
    expect(isStudioScopePath('/setup/account')).toBe(false);
    expect(isStudioScopePath('/.well-known/openid-configuration')).toBe(false);
  });

  it('treats default admin bait paths as Studio scope', () => {
    for (const bait of [
      '/admin',
      '/administrator',
      '/studio',
      '/wp-admin',
      '/login',
      '/dashboard',
      '/cms',
    ]) {
      expect(isStudioScopePath(bait)).toBe(true);
    }
  });

  it('treats unknown root paths as Studio scope', () => {
    expect(isStudioScopePath('/lumi-7f3a9c')).toBe(true);
    expect(isStudioScopePath('/lumi-7f3a9c/assets/main.js')).toBe(true);
    expect(isStudioScopePath('/random')).toBe(true);
  });
});

describe('pathMatchesAdminScope', () => {
  it('matches an exact admin path', () => {
    expect(pathMatchesAdminScope('/lumi-7f3a9c', '/lumi-7f3a9c')).toBe(true);
  });

  it('matches sub-paths under the admin path', () => {
    expect(pathMatchesAdminScope('/lumi-7f3a9c/', '/lumi-7f3a9c')).toBe(true);
    expect(
      pathMatchesAdminScope('/lumi-7f3a9c/assets/app.js', '/lumi-7f3a9c'),
    ).toBe(true);
  });

  it('rejects sibling paths that share a prefix', () => {
    // Common timing-attack vector — `/lumi-7f3a9cX` happens to share
    // the admin path's prefix but is a distinct route.
    expect(pathMatchesAdminScope('/lumi-7f3a9cx', '/lumi-7f3a9c')).toBe(false);
    expect(pathMatchesAdminScope('/lumi-7f3a9c-extra', '/lumi-7f3a9c')).toBe(false);
  });

  it('rejects empty/missing admin path', () => {
    expect(pathMatchesAdminScope('/lumi-7f3a9c', '')).toBe(false);
  });
});

// ── bypass cases (guard returns next()) ────────────────────────────────

describe('adminPathGuard — bypass behaviour', () => {
  it('bypasses /api/* without reading state', async () => {
    const { db, state } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);
    const res = await app.request('/api/v1/users');
    expect(res.status).toBe(200);
    // No DB read at all because the path-prefix bypass triggers
    // before the cache lookup.
    expect(state.selectCount).toBe(0);
    expect(state.noopCount).toBe(0);
  });

  it('bypasses /health and /metrics', async () => {
    const { db, state } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);
    const r1 = await app.request('/health');
    const r2 = await app.request('/metrics');
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(state.selectCount).toBe(0);
  });

  it("bypasses while state is 'uninitialized' so the wizard is reachable", async () => {
    const { db, state } = makeFakeDb({ state: 'uninitialized' });
    const app = buildApp(db);
    // `/setup` is in the explicit ops bypass; even arbitrary paths
    // should pass through during pre-init so the bootstrap admin
    // can be created.
    const r = await app.request('/admin');
    expect(r.status).toBe(200);
    // The state read happened, but the no-op for the 404 path did not.
    expect(state.selectCount).toBe(1);
    expect(state.noopCount).toBe(0);
  });

  it("bypasses while state is 'initializing'", async () => {
    const { db } = makeFakeDb({ state: 'initializing' });
    const app = buildApp(db);
    const r = await app.request('/admin');
    expect(r.status).toBe(200);
  });

  it('serves Studio HTML and tags the response with STUDIO_HTML when the path matches', async () => {
    const { db } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);
    const res = await app.request('/lumi-7f3a9c');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tag: string | null };
    expect(body.ok).toBe(true);
    expect(body.tag).toBe('STUDIO_HTML');
  });

  it('matches admin sub-paths and tags STUDIO_HTML', async () => {
    const { db } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);
    const res = await app.request('/lumi-7f3a9c/assets/app.js');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tag: string | null };
    expect(body.tag).toBe('STUDIO_HTML');
  });
});

// ── 404 cases (Req 5.1, 5.6, 5.7) ──────────────────────────────────────

describe('adminPathGuard — indistinguishable 404', () => {
  it('returns canonical 404 envelope for default bait paths once initialized', async () => {
    const { db, state } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);

    for (const bait of ['/admin', '/studio', '/wp-admin', '/login']) {
      const res = await app.request(bait);
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ errors: [{ code: 'NOT_FOUND' }] });
    }

    // Each 404 ran the SELECT 1 no-op for latency parity.
    expect(state.noopCount).toBe(4);
  });

  it('returns 404 for arbitrary unknown paths once initialized (Req 5.6)', async () => {
    const { db } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);
    const res = await app.request('/something-random');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ errors: [{ code: 'NOT_FOUND' }] });
  });

  it('rejects sibling paths that share a prefix (timing-safe)', async () => {
    const { db } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);
    const res = await app.request('/lumi-7f3a9cx');
    expect(res.status).toBe(404);
  });

  it('only emits Content-Type and Content-Length headers on 404 (no leakage)', async () => {
    const { db } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);
    const res = await app.request('/admin');
    expect(res.status).toBe(404);

    const allowed = new Set(['content-type', 'content-length']);
    const seen: string[] = [];
    res.headers.forEach((_, key) => {
      seen.push(key.toLowerCase());
    });
    for (const name of seen) {
      expect(allowed.has(name)).toBe(true);
    }
    // Both headers must be present and content-length must equal the
    // canonical body byte length so all 404 responses are byte-equal.
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const expected = String(
      new TextEncoder().encode(JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] })).byteLength,
    );
    expect(res.headers.get('content-length')).toBe(expected);
  });

  it('runs SELECT 1 no-op exactly once per mismatch (latency parity, Req 5.1)', async () => {
    const { db, state } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);
    await app.request('/admin');
    expect(state.noopCount).toBe(1);
  });

  it('returns 404 when initialized but admin_path is unexpectedly null', async () => {
    const { db } = makeFakeDb({ state: 'initialized', adminPath: null });
    const app = buildApp(db);
    const res = await app.request('/anything');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ errors: [{ code: 'NOT_FOUND' }] });
  });
});

// ── caching behaviour ──────────────────────────────────────────────────

describe('adminPathGuard — state caching', () => {
  it('reads state at most once per cache window across many requests', async () => {
    const { db, state } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);
    // 10 requests in quick succession should hit the cache after the
    // first.
    for (let i = 0; i < 10; i++) {
      await app.request('/lumi-7f3a9c');
    }
    expect(state.selectCount).toBe(1);
  });

  it('coalesces concurrent cache misses to a single read', async () => {
    const { db, state } = makeFakeDb({
      state: 'initialized',
      adminPath: '/lumi-7f3a9c',
    });
    const app = buildApp(db);
    await Promise.all(
      Array.from({ length: 8 }, () => app.request('/lumi-7f3a9c')),
    );
    expect(state.selectCount).toBe(1);
  });
});

// ── failure handling ───────────────────────────────────────────────────

describe('adminPathGuard — DB read failure', () => {
  it('fails closed (canonical 404) when state read errors out', async () => {
    const { db } = makeFakeDb({ failOnSelect: true });
    const app = buildApp(db);
    // Suppress the expected console.error noise — the guard logs the read
    // failure before failing closed.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.request('/admin');
    errSpy.mockRestore();
    // A DB hiccup must NOT downgrade the guard into leaking that the Studio
    // path is special — it emits the same indistinguishable 404 as a miss.
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ errors: [{ code: 'NOT_FOUND' }] });
  });

  it('fails closed (canonical 404) when no DB is resolvable', async () => {
    // `c.get('db')` unset → resolveDb() returns null. Rather than bypassing
    // the guard, a degraded/misconfigured deployment must still 404 Studio
    // paths so their existence cannot be probed.
    const app = new Hono<AppEnv>();
    app.use('*', adminPathGuard());
    app.all('*', (c) => c.json({ ok: true }, 200));
    const res = await app.request('/admin');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ errors: [{ code: 'NOT_FOUND' }] });
  });
});
