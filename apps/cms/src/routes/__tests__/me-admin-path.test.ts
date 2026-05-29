import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { meRouter } from '../auth';

/**
 * Unit tests for `GET /api/v1/me/admin-path` (admin-setup-wizard task
 * 4.4; Req 4.7; design §7.3).
 *
 * The route lives on `meRouter` (exported from `routes/auth.ts`) and is
 * mounted by `apps/cms/src/index.ts` under the authenticated `api`
 * Hono instance, which means `withAuth` runs upstream. Authentication
 * itself is covered by the existing `withAuth` tests; here we focus on
 * the handler's behaviour:
 *
 *   - reads `system_state.admin_path` once and returns it inside the
 *     project-standard `{ data: { adminPath } }` envelope;
 *   - returns a 404 `ADMIN_PATH_UNAVAILABLE` envelope when the path is
 *     `null` (uninitialized instance) so callers can render a clear
 *     "not yet bootstrapped" empty state instead of treating it as an
 *     auth failure.
 *
 * The DB layer is stubbed by a tiny fluent shim mirroring the one in
 * `middleware/__tests__/admin-path-guard.test.ts` so the test does not
 * need a real Postgres or runtime adapter.
 */

interface FakeDbState {
  adminPath: string | null;
  selectCount: number;
}

function makeFakeDb(initial: { adminPath: string | null }): {
  db: Database;
  state: FakeDbState;
} {
  const state: FakeDbState = {
    adminPath: initial.adminPath,
    selectCount: 0,
  };

  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => {
      state.selectCount += 1;
      // The handler selects only `{ adminPath }`.
      return Promise.resolve([{ adminPath: state.adminPath }]);
    },
  };

  const db = {
    select: () => fluent,
  } as unknown as Database;

  return { db, state };
}

function buildApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // The production mount in `index.ts` has `withAuth` running first;
  // here we stand in for it by injecting both `auth` and `db` so the
  // handler can rely on `c.get('db')`. The route under test does not
  // touch `auth`, but a real request would have it set.
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('auth', {
      userId: 'usr_test',
      email: 'admin@example.com',
      roles: ['admin'],
      raw: {},
    });
    await next();
  });
  app.route('/api/v1/me', meRouter);
  return app;
}

describe('GET /api/v1/me/admin-path', () => {
  it('returns the configured admin path inside the standard envelope', async () => {
    const { db, state } = makeFakeDb({ adminPath: '/lumi-7f3a9c' });
    const app = buildApp(db);

    const res = await app.request('/api/v1/me/admin-path');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { adminPath: '/lumi-7f3a9c' },
    });
    // The handler should read `system_state` exactly once per request.
    expect(state.selectCount).toBe(1);
  });

  it('returns 404 ADMIN_PATH_UNAVAILABLE when the path is null', async () => {
    const { db } = makeFakeDb({ adminPath: null });
    const app = buildApp(db);

    const res = await app.request('/api/v1/me/admin-path');
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      errors: { code: string; message?: string }[];
    };
    expect(body.errors[0]?.code).toBe('ADMIN_PATH_UNAVAILABLE');
  });

  it('does not leak the admin path through any other field (Req 4.7 / §7.3)', async () => {
    // The endpoint is the *only* legitimate channel for the path, so
    // this sanity-check ensures the response body shape stays minimal.
    // Anything beyond `data.adminPath` would be a regression that
    // could surface the secret in unexpected places (logs, headers,
    // analytics tooling that hooks generic JSON fields).
    const { db } = makeFakeDb({ adminPath: '/lumi-7f3a9c' });
    const app = buildApp(db);

    const res = await app.request('/api/v1/me/admin-path');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['data']);
    expect(Object.keys(body.data as Record<string, unknown>)).toEqual([
      'adminPath',
    ]);
  });
});
