import type { Database } from '@lumibase/database';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../env';
import { requireSetupComplete } from '../setup-required';

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
});
