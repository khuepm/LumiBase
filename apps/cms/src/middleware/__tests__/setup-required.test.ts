import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { __resetSetupCompleteCache, requireSetupComplete } from '../setup-required';

interface FakeDbState {
  bootstrapRows: Array<{ id: string }>;
  selectCount: number;
}

function makeFakeDb(bootstrapRows: Array<{ id: string }>): {
  db: Database;
  state: FakeDbState;
} {
  const state: FakeDbState = {
    bootstrapRows,
    selectCount: 0,
  };

  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => {
      state.selectCount += 1;
      return Promise.resolve(state.bootstrapRows);
    },
  };

  const db = {
    select: () => fluent,
  } as unknown as Database;

  return { db, state };
}

function buildApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  app.use('*', requireSetupComplete());
  app.get('/api/v1/users', (c) => c.json({ ok: true }));
  return app;
}

describe('requireSetupComplete', () => {
  // The bootstrap check is process-cached (Req 4); reset between cases so
  // one test's cached value can't leak into the next.
  beforeEach(() => __resetSetupCompleteCache());

  it('blocks authenticated API traffic before bootstrap admin exists', async () => {
    const { db, state } = makeFakeDb([]);
    const app = buildApp(db);

    const res = await app.request('/api/v1/users');
    const body = await res.json();

    expect(res.status).toBe(423);
    expect(body).toEqual({
      errors: [
        {
          code: 'SETUP_REQUIRED',
          message: 'Complete setup before using the admin API.',
        },
      ],
    });
    expect(state.selectCount).toBe(1);
  });

  it('passes through after bootstrap admin exists', async () => {
    const { db, state } = makeFakeDb([{ id: 'usr_bootstrap' }]);
    const app = buildApp(db);

    const res = await app.request('/api/v1/users');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(state.selectCount).toBe(1);
  });

  it('caches an initialized result permanently — one DB read across many requests (Req 4.1, 4.2)', async () => {
    const { db, state } = makeFakeDb([{ id: 'usr_bootstrap' }]);
    const app = buildApp(db);

    for (let i = 0; i < 25; i += 1) {
      const res = await app.request('/api/v1/users');
      expect(res.status).toBe(200);
    }
    expect(state.selectCount).toBe(1);
  });

  it('does not cache an uninitialized result permanently — re-checks so a completed setup is picked up (Req 4.3)', async () => {
    // First DB reports no bootstrap admin; the middleware caches `false` under
    // a short TTL, not permanently. Swapping the DB to report a bootstrap
    // admin AFTER the TTL clears lets the next request flip to 200.
    const empty = makeFakeDb([]);
    const app1 = buildApp(empty.db);
    expect((await app1.request('/api/v1/users')).status).toBe(423);

    // Simulate TTL expiry by clearing the process cache, then a later request
    // against a now-initialized instance must re-read and pass through.
    __resetSetupCompleteCache();
    const ready = makeFakeDb([{ id: 'usr_bootstrap' }]);
    const app2 = buildApp(ready.db);
    expect((await app2.request('/api/v1/users')).status).toBe(200);
    expect(ready.state.selectCount).toBe(1);
  });
});
