import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import { RestrictionService } from '../restriction-service';
import { restrictionRouter } from '../../../routes/restriction';

const FIXED_NOW = new Date('2026-06-24T10:00:00.000Z');

function makeFakeDb(selectRows: ReadonlyArray<Record<string, unknown>>) {
  const captured: { set?: any; values?: any } = {};
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
          return Promise.resolve(selectRows);
        },
      };
      return chain;
    },
    insert() {
      const chain: any = {
        values(v: unknown) {
          chain._v = v;
          captured.values = v;
          return chain;
        },
        onConflictDoUpdate(cfg: { set: unknown }) {
          captured.set = cfg.set;
          return chain;
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
  };
  return { db: db as AppEnv['Variables']['db'], captured };
}

describe('RestrictionService', () => {
  it('isRestricted reflects the stored flag', async () => {
    expect(
      await new RestrictionService({ db: makeFakeDb([{ restricted: true }]).db }).isRestricted({
        siteId: 's',
        userId: 'u',
      }),
    ).toBe(true);
    expect(
      await new RestrictionService({ db: makeFakeDb([]).db }).isRestricted({ siteId: 's', userId: 'u' }),
    ).toBe(false);
  });

  it('set upserts the restriction state', async () => {
    const { db, captured } = makeFakeDb([]);
    const row = await new RestrictionService({ db, now: () => FIXED_NOW }).set({
      siteId: 's',
      userId: 'u',
      restricted: true,
      reason: 'dispute',
    });
    expect((row as any).restricted).toBe(true);
    expect(captured.set.restricted).toBe(true);
    expect(captured.set.reason).toBe('dispute');
  });
});

describe('/me/restriction routes', () => {
  function buildApp(auth: Record<string, unknown>, selectRows: ReadonlyArray<Record<string, unknown>> = []) {
    const { db } = makeFakeDb(selectRows);
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('auth', auth as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_test');
      await next();
    });
    app.route('/me/restriction', restrictionRouter);
    return app;
  }

  it('rejects an API-key principal', async () => {
    const res = await buildApp({ type: 'api_key', raw: {} }).request('/me/restriction', { method: 'GET' });
    expect(res.status).toBe(400);
  });

  it('rejects a body without a boolean restricted', async () => {
    const res = await buildApp({ userId: 'u', email: 'a@b.co', raw: {} }).request('/me/restriction', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('sets restriction for a user principal', async () => {
    const res = await buildApp({ userId: 'u', email: 'a@b.co', raw: {} }).request('/me/restriction', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ restricted: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { restricted: boolean } };
    expect(body.data.restricted).toBe(true);
  });
});
