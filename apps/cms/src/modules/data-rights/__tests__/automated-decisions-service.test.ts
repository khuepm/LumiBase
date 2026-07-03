import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import { AutomatedDecisionsService } from '../automated-decisions-service';
import { automatedDecisionsRouter } from '../../../routes/automated-decisions';

const FIXED_NOW = new Date('2026-06-24T10:00:00.000Z');

function makeFakeDb(rows: ReadonlyArray<Record<string, unknown>>) {
  return {
    select() {
      const chain: any = {
        from() {
          return chain;
        },
        innerJoin() {
          return chain;
        },
        where() {
          return chain;
        },
        orderBy() {
          return chain;
        },
        limit() {
          return Promise.resolve(rows);
        },
      };
      return chain;
    },
  } as unknown as AppEnv['Variables']['db'];
}

describe('AutomatedDecisionsService', () => {
  it('maps agent revisions with provenance and ISO timestamps', async () => {
    const db = makeFakeDb([
      {
        revisionId: 'r1',
        itemId: 'i1',
        collectionId: 'c1',
        model: 'claude-opus-4-8',
        sources: ['url:1'],
        confidence: 0.9,
        createdAt: FIXED_NOW,
      },
    ]);
    const out = await new AutomatedDecisionsService({ db }).list({ siteId: 's', userId: 'u' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      revisionId: 'r1',
      model: 'claude-opus-4-8',
      confidence: 0.9,
      createdAt: FIXED_NOW.toISOString(),
    });
  });

  it('returns an empty list when there are no agent decisions', async () => {
    const out = await new AutomatedDecisionsService({ db: makeFakeDb([]) }).list({ siteId: 's', userId: 'u' });
    expect(out).toEqual([]);
  });
});

describe('GET /me/automated-decisions', () => {
  function buildApp(auth: Record<string, unknown>, rows: ReadonlyArray<Record<string, unknown>> = []) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', makeFakeDb(rows));
      c.set('auth', auth as never);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_test');
      await next();
    });
    app.route('/me/automated-decisions', automatedDecisionsRouter);
    return app;
  }

  it('rejects an API-key principal', async () => {
    const res = await buildApp({ type: 'api_key', raw: {} }).request('/me/automated-decisions');
    expect(res.status).toBe(400);
  });

  it('returns decisions for a user principal', async () => {
    const res = await buildApp({ userId: 'u', email: 'a@b.co', raw: {} }, [
      { revisionId: 'r1', itemId: 'i1', collectionId: 'c1', model: 'm', sources: null, confidence: null, createdAt: FIXED_NOW },
    ]).request('/me/automated-decisions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });
});
