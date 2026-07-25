import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../env';
import { consentRouter } from '../consent';

type AuthLike = { userId?: string; externalId?: string; email?: string; type?: string; raw: Record<string, unknown> };

/** Minimal fake DB whose `select(...).from().where()` resolves to scripted rows. */
function makeFakeDb(listRows: ReadonlyArray<Record<string, unknown>>) {
  return {
    select() {
      const builder: any = {
        from() {
          return builder;
        },
        where() {
          return builder;
        },
        limit() {
          return Promise.resolve(listRows);
        },
        then(resolve: (rows: unknown) => unknown) {
          return Promise.resolve(listRows).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as AppEnv['Variables']['db'];
}

function buildApp(auth: AuthLike, listRows: ReadonlyArray<Record<string, unknown>> = []): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', makeFakeDb(listRows));
    c.set('auth', auth as never);
    c.set('siteId', 'site_test');
    c.set('requestId', 'req_test');
    await next();
  });
  app.route('/me/consents', consentRouter);
  return app;
}

const apiKeyPrincipal: AuthLike = { type: 'api_key', raw: {} };
const userPrincipal: AuthLike = { userId: 'user_1', email: 'a@b.co', raw: {} };

describe('PUT /me/consents/:type — validation', () => {
  it('rejects an unknown consent type with 400 VALIDATION', async () => {
    const app = buildApp(userPrincipal);
    const res = await app.request('/me/consents/tracking', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe('VALIDATION');
  });

  it('rejects a body without a boolean `granted` with 400 VALIDATION', async () => {
    const app = buildApp(userPrincipal);
    const res = await app.request('/me/consents/marketing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe('VALIDATION');
  });

  it('rejects an API-key principal (no user context) with 400 USER_CONTEXT_REQUIRED', async () => {
    const app = buildApp(apiKeyPrincipal);
    const res = await app.request('/me/consents/marketing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ granted: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe('USER_CONTEXT_REQUIRED');
  });
});

describe('GET /me/consents', () => {
  it('rejects an API-key principal with 400 USER_CONTEXT_REQUIRED', async () => {
    const app = buildApp(apiKeyPrincipal);
    const res = await app.request('/me/consents', { method: 'GET' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0]!.code).toBe('USER_CONTEXT_REQUIRED');
  });

  it('returns the current user\'s consent records', async () => {
    const now = new Date('2026-06-24T10:00:00.000Z');
    const app = buildApp(userPrincipal, [
      {
        id: 'c1',
        siteId: 'site_test',
        userId: 'user_1',
        consentType: 'marketing',
        granted: true,
        grantedAt: now,
        withdrawnAt: null,
        source: 'signup',
        version: 'v1',
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const res = await app.request('/me/consents', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { consentType: string; granted: boolean }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.consentType).toBe('marketing');
    expect(body.data[0]!.granted).toBe(true);
  });
});
