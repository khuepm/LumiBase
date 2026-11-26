import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { MemoryCacheProvider, MemoryRateLimiter } from '@lumibase/runtime';

import type { AppEnv } from '../../env';
import { appErrorHandler } from '../../lib/app-error-handler';
import { authRouter, meRouter } from '../auth';

/**
 * #1046 — `/auth/login`, `/auth/forgot-password`, `/auth/reset-password`,
 * `/auth/resend-verification` and `/me/change-password` called
 * `schema.parse(await c.req.json())`, so an empty object or a non-JSON body
 * escaped to `app.onError` as a 500 INTERNAL. They now answer 400 VALIDATION,
 * before any database read: the db here is a trap, any access fails the
 * request with a 500 the assertions would catch.
 */

const trapDb = new Proxy(
  {},
  {
    get() {
      throw new Error('database touched');
    },
  },
);

type ErrorBody = { errors: Array<{ code: string; message: string }> };

function buildApp(opts: { db?: unknown; peekBody?: boolean } = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const runtime = { cache: new MemoryCacheProvider(), rateLimiter: new MemoryRateLimiter() };
  app.use('*', async (c, next) => {
    c.set('db', ('db' in opts ? opts.db : trapDb) as never);
    c.set('siteId', 'site_1046');
    c.set('runtime', runtime as never);
    c.set('auth', { userId: 'user_1046' } as never);
    await next();
  });
  if (opts.peekBody) {
    // Mirrors LoginGuard's `readEmailFromRequest`, which reads the body
    // before the handler and swallows a parse failure. Hono caches the
    // (rejected) body promise, so the handler must still answer 400.
    app.use('*', async (c, next) => {
      await c.req.json().catch(() => undefined);
      await next();
    });
  }
  app.route('/api/v1/auth', authRouter);
  app.route('/api/v1/me', meRouter);
  app.onError(appErrorHandler);
  return app;
}

let ipSeq = 0;
function post(app: Hono<AppEnv>, path: string, body: string): Promise<Response> {
  ipSeq += 1;
  return Promise.resolve(
    app.request(
      `/api/v1/${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${ipSeq % 250}` },
        body,
      },
      { JWT_SECRET: 'auth-invalid-body-test-only' } as AppEnv['Bindings'],
    ),
  );
}

async function expectValidation(res: Response): Promise<ErrorBody> {
  expect(res.status).toBe(400);
  const json = (await res.json()) as ErrorBody;
  expect(json.errors.length).toBeGreaterThan(0);
  for (const e of json.errors) {
    expect(e.code).toBe('VALIDATION');
    expect(typeof e.message).toBe('string');
    // Shape-only messages: nothing about whether an account exists.
    expect(e.message).not.toMatch(/exist|not found|unknown user|registered|locked/i);
  }
  return json;
}

// `login` runs behind LoginGuard, which needs a real db; the handler itself
// reads no db before validation, so it runs with none and with the guard's
// body peek reproduced in front of it.
const ROUTES: Array<{ path: string; valid: string; db?: unknown }> = [
  { path: 'auth/login', valid: JSON.stringify({ email: 'a@example.com', password: 'x' }), db: undefined },
  { path: 'auth/forgot-password', valid: JSON.stringify({ email: 'a@example.com' }) },
  { path: 'auth/resend-verification', valid: JSON.stringify({ email: 'a@example.com' }) },
  {
    path: 'auth/reset-password',
    valid: JSON.stringify({ token: 'not-a-jwt', password: 'Correct-Horse-Battery-1046!' }),
  },
  {
    path: 'me/change-password',
    valid: JSON.stringify({ currentPassword: 'old', newPassword: 'Correct-Horse-Battery-1046!' }),
  },
];

describe.each(ROUTES)('POST /$path — invalid body (#1046)', ({ path, valid, ...rest }) => {
  const appOpts = 'db' in rest ? { db: rest.db } : {};

  it('answers 400 VALIDATION for an empty object', async () => {
    await expectValidation(await post(buildApp(appOpts), path, '{}'));
  });

  it('answers 400 VALIDATION for a body that is not JSON', async () => {
    const json = await expectValidation(await post(buildApp(appOpts), path, 'not-json'));
    expect(json.errors[0]?.message).toBe('Body must be valid JSON.');
  });

  it('answers 400 VALIDATION for an empty body', async () => {
    await expectValidation(await post(buildApp(appOpts), path, ''));
  });

  it('still answers 400 when middleware already read the malformed body', async () => {
    await expectValidation(await post(buildApp({ ...appOpts, peekBody: true }), path, 'not-json'));
  });

  it('lets a well-formed body through validation', async () => {
    const res = await post(buildApp(appOpts), path, valid);
    if (res.status === 400) {
      const json = (await res.json()) as ErrorBody;
      expect(json.errors.map((e) => e.code)).not.toContain('VALIDATION');
    }
  });
});
