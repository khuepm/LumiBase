import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import { ErasureService, DEFAULT_ERASURE_GRACE_DAYS } from '../erasure-service';
import { meErasureRouter } from '../../../routes/erasure';

const FIXED_NOW = new Date('2026-06-24T10:00:00.000Z');

interface Scripts {
  select?: unknown[][];
  updateReturning?: unknown[][];
}

function makeFakeDb(scripts: Scripts = {}) {
  const selectQ = [...(scripts.select ?? [])];
  const updateRetQ = [...(scripts.updateReturning ?? [])];
  const captured: {
    inserts: any[];
    updates: any[];
    conflictSet?: any;
    deletes: number;
  } = { inserts: [], updates: [], deletes: 0 };

  const db: any = {
    select() {
      const chain: any = {
        from() {
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          return Promise.resolve(selectQ.shift() ?? []);
        },
        then(r: (v: unknown) => unknown) {
          return Promise.resolve(selectQ.shift() ?? []).then(r);
        },
      };
      return chain;
    },
    insert() {
      const chain: any = {
        values(v: unknown) {
          chain._v = v;
          captured.inserts.push(v);
          return chain;
        },
        onConflictDoUpdate(cfg: { set: unknown }) {
          captured.conflictSet = cfg.set;
          return chain;
        },
        onConflictDoNothing() {
          return Promise.resolve();
        },
        returning() {
          return Promise.resolve([chain._v]);
        },
        then(r: (v: unknown) => unknown) {
          return Promise.resolve(undefined).then(r);
        },
      };
      return chain;
    },
    update() {
      const chain: any = {
        set(v: unknown) {
          captured.updates.push(v);
          return chain;
        },
        where() {
          return chain;
        },
        returning() {
          return Promise.resolve(updateRetQ.shift() ?? []);
        },
        then(r: (v: unknown) => unknown) {
          return Promise.resolve(undefined).then(r);
        },
      };
      return chain;
    },
    delete() {
      const chain: any = {
        where() {
          captured.deletes += 1;
          return chain;
        },
        returning() {
          return Promise.resolve([]);
        },
        then(r: (v: unknown) => unknown) {
          return Promise.resolve(undefined).then(r);
        },
      };
      return chain;
    },
  };
  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return { db: db as AppEnv['Variables']['db'], captured };
}

describe('ErasureService.request', () => {
  it('opens a pending request with a grace-period deadline', async () => {
    const { db } = makeFakeDb({ select: [[{ email: 'a@b.co' }]] });
    const service = new ErasureService({ db, now: () => FIXED_NOW });
    const row = await service.request({ siteId: 'site_1', userId: 'user_1' });
    const expected = new Date(FIXED_NOW.getTime() + DEFAULT_ERASURE_GRACE_DAYS * 86_400_000);
    expect((row as any).status).toBe('pending');
    expect((row as any).scheduledAt).toEqual(expected);
    expect((row as any).emailSnapshot).toBe('a@b.co');
  });
});

describe('ErasureService.eraseNow', () => {
  it('anonymizes PII, drops credentials, and completes the request', async () => {
    const { db, captured } = makeFakeDb({ select: [[{ email: 'Bob@b.co' }]] });
    const service = new ErasureService({ db, now: () => FIXED_NOW });
    const { anonymizedEmail } = await service.eraseNow({ siteId: 'site_1', userId: 'user_1' });

    expect(anonymizedEmail).toBe('erased-user_1@erased.invalid');
    // 5 membership/credential deletes happened.
    expect(captured.deletes).toBe(5);
    // The users row was anonymized.
    const usersSet = captured.updates[0];
    expect(usersSet.email).toBe('erased-user_1@erased.invalid');
    expect(usersSet.firstName).toBeNull();
    expect(usersSet.lastName).toBeNull();
    expect(usersSet.passwordHash).toBeNull();
    expect(usersSet.externalId).toBeNull();
    expect(usersSet.preferences).toEqual({});
    // The original email was suppressed.
    expect(captured.inserts.some((v) => v.emailLower === 'bob@b.co')).toBe(true);
    // The erasure request was marked completed.
    const reqSet = captured.updates[1];
    expect(reqSet.status).toBe('completed');
    expect(reqSet.completedAt).toEqual(FIXED_NOW);
  });
});

describe('ErasureService.cancel', () => {
  it('returns true when a pending request was cancelled', async () => {
    const { db } = makeFakeDb({ updateReturning: [[{ id: 'e1' }]] });
    expect(await new ErasureService({ db, now: () => FIXED_NOW }).cancel({ siteId: 's', userId: 'u' })).toBe(true);
  });
  it('returns false when nothing was pending', async () => {
    const { db } = makeFakeDb({ updateReturning: [[]] });
    expect(await new ErasureService({ db, now: () => FIXED_NOW }).cancel({ siteId: 's', userId: 'u' })).toBe(false);
  });
});

describe('/me/erasure routes', () => {
  function buildApp(auth: Record<string, unknown>, scripts: Scripts = {}) {
    const { db } = makeFakeDb(scripts);
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('auth', auth as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_test');
      await next();
    });
    app.route('/me/erasure', meErasureRouter);
    return app;
  }

  it('rejects an API-key principal', async () => {
    const res = await buildApp({ type: 'api_key', raw: {} }).request('/me/erasure', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('opens a request for a user principal (202)', async () => {
    const res = await buildApp({ userId: 'user_1', email: 'a@b.co', raw: {} }, {
      select: [[{ email: 'a@b.co' }]],
    }).request('/me/erasure', { method: 'POST' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('pending');
  });

  it('cancel returns 404 when nothing pending', async () => {
    const res = await buildApp({ userId: 'user_1', email: 'a@b.co', raw: {} }, {
      updateReturning: [[]],
    }).request('/me/erasure', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
