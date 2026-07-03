import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import {
  SuppressionService,
  buildUnsubscribeUrl,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../suppression';
import { emailPublicRouter } from '../../../routes/email-public';

const SECRET = 'test-secret-please-ignore';

// ---------------------------------------------------------------------------
// Stateless unsubscribe tokens
// ---------------------------------------------------------------------------

describe('unsubscribe tokens', () => {
  it('round-trips siteId + normalized email', async () => {
    const token = await createUnsubscribeToken({ siteId: 'site_1', email: '  Bob@Example.COM ' }, SECRET);
    const claims = await verifyUnsubscribeToken(token, SECRET);
    expect(claims).toEqual({ siteId: 'site_1', email: 'bob@example.com' });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await createUnsubscribeToken({ siteId: 'site_1', email: 'a@b.co' }, SECRET);
    expect(await verifyUnsubscribeToken(token, 'other-secret')).toBeNull();
  });

  it('rejects a malformed token', async () => {
    expect(await verifyUnsubscribeToken('not-a-jwt', SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken('', SECRET)).toBeNull();
  });

  it('builds a public unsubscribe URL', () => {
    expect(buildUnsubscribeUrl('https://cms.example.com/', 'abc')).toBe(
      'https://cms.example.com/api/v1/email/unsubscribe?token=abc',
    );
  });
});

// ---------------------------------------------------------------------------
// SuppressionService.filter — fake DB
// ---------------------------------------------------------------------------

function makeFakeDb(selectRows: ReadonlyArray<Record<string, unknown>>) {
  return {
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
        then(res: (rows: unknown) => unknown) {
          return Promise.resolve(selectRows).then(res);
        },
      };
      return chain;
    },
    insert() {
      const chain: any = {
        values() {
          return chain;
        },
        onConflictDoNothing() {
          return Promise.resolve();
        },
        returning() {
          return Promise.resolve([]);
        },
        then(res: (v: unknown) => unknown) {
          return Promise.resolve(undefined).then(res);
        },
      };
      return chain;
    },
  } as unknown as AppEnv['Variables']['db'];
}

describe('SuppressionService.filter', () => {
  it('removes suppressed addresses (case-insensitive)', async () => {
    const db = makeFakeDb([{ emailLower: 'blocked@x.co' }]);
    const service = new SuppressionService({ db });
    const remaining = await service.filter({
      siteId: 'site_1',
      emails: ['Keep@x.co', 'BLOCKED@x.co'],
    });
    expect(remaining).toEqual(['Keep@x.co']);
  });

  it('isSuppressed reflects the lookup', async () => {
    expect(await new SuppressionService({ db: makeFakeDb([{ id: 's1' }]) }).isSuppressed({ siteId: 's', email: 'a@b.co' })).toBe(true);
    expect(await new SuppressionService({ db: makeFakeDb([]) }).isSuppressed({ siteId: 's', email: 'a@b.co' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Public unsubscribe route
// ---------------------------------------------------------------------------

function buildApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', makeFakeDb([]));
    c.set('requestId', 'req_test');
    await next();
  });
  app.route('/api/v1/email', emailPublicRouter);
  return app;
}

const ENV = { JWT_SECRET: SECRET } as unknown as AppEnv['Bindings'];

describe('GET /api/v1/email/unsubscribe', () => {
  it('returns 400 for a missing token', async () => {
    const res = await buildApp().request('/api/v1/email/unsubscribe', { method: 'GET' }, ENV);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid token', async () => {
    const res = await buildApp().request('/api/v1/email/unsubscribe?token=garbage', { method: 'GET' }, ENV);
    expect(res.status).toBe(400);
  });

  it('suppresses and returns 200 for a valid token', async () => {
    const token = await createUnsubscribeToken({ siteId: 'site_1', email: 'a@b.co' }, SECRET);
    const res = await buildApp().request(
      `/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`,
      { method: 'GET' },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('unsubscribed');
  });

  it('one-click POST returns 200 for a valid token', async () => {
    const token = await createUnsubscribeToken({ siteId: 'site_1', email: 'a@b.co' }, SECRET);
    const res = await buildApp().request(
      `/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`,
      { method: 'POST' },
      ENV,
    );
    expect(res.status).toBe(200);
  });
});
