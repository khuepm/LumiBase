import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MemoryCacheProvider, MemoryRateLimiter } from '@lumibase/runtime';

import type { AppEnv } from '../../env';
import { authRouter } from '../auth';
import { TOKEN_CONSUME_RATE_LIMIT } from '../../modules/auth/registration-guard';

/**
 * #732 — `/auth/verify-email` and `/auth/reset-password` had no per-IP brake
 * (register / resend-verification / forgot-password did). They now share
 * {@link TOKEN_CONSUME_RATE_LIMIT}, checked before any JWT verify, body work or
 * password hashing — so a throttled request never touches the database. The
 * db here is a trap: any access fails the test.
 */

const trapDb = new Proxy(
  {},
  {
    get() {
      throw new Error('database touched');
    },
  },
);

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const runtime = { cache: new MemoryCacheProvider(), rateLimiter: new MemoryRateLimiter() };
  app.use('*', async (c, next) => {
    c.set('db', trapDb as never);
    c.set('siteId', 'site_732');
    c.set('runtime', runtime as never);
    await next();
  });
  app.route('/api/v1/auth', authRouter);
  return app;
}

function post(app: Hono<AppEnv>, path: string, body: unknown, ip: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/api/v1/auth/${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify(body),
      },
      { JWT_SECRET: 'auth-token-brake-test-only' } as AppEnv['Bindings'],
    ),
  );
}

describe.each([
  ['verify-email', { token: 'not-a-jwt' }],
  ['reset-password', { token: 'not-a-jwt', password: 'Correct-Horse-Battery-732!' }],
])('POST /auth/%s — per-IP brake', (path, body) => {
  it('answers 429 with retry-after once the IP spends its budget, and other IPs are unaffected', async () => {
    const app = buildApp();
    for (let i = 0; i < TOKEN_CONSUME_RATE_LIMIT.maxPerWindow; i += 1) {
      // A forged token is refused (400) without a database read.
      expect((await post(app, path, body, '203.0.113.50')).status).toBe(400);
    }
    const blocked = await post(app, path, body, '203.0.113.50');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    const json = (await blocked.json()) as { errors: Array<{ code: string }> };
    expect(json.errors[0]?.code).toBe('RATE_LIMITED');

    expect((await post(app, path, body, '203.0.113.51')).status).toBe(400);
  });

  it('holds against a parallel burst from one IP', async () => {
    const app = buildApp();
    const burst = TOKEN_CONSUME_RATE_LIMIT.maxPerWindow + 10;
    const statuses = await Promise.all(
      Array.from({ length: burst }, async () => (await post(app, path, body, '203.0.113.52')).status),
    );
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
  });
});
