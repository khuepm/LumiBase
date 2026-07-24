import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import { setupRouter, __resetSetupRateLimitForTests } from '../routes';

/**
 * Route tests for the per-IP rate brake on `POST /api/v1/setup/complete`
 * (spec `.kiro/specs/setup-complete-rate-brake/`).
 *
 * The brake fires *before* the body is parsed or the service runs, so it
 * guards the pre-initialized window against setupToken brute-force and
 * password-hashing spam. A stub is injected via
 * `c.set('setupServiceOverride', stub)` — the same seam the router honours
 * for the real service — so no Postgres is touched and we can assert the
 * service is NOT called on a throttled request.
 *
 * Coverage:
 *   - COMPLETE_RATE_LIMIT + 1 requests from one IP → last is 429 + Retry-After,
 *     and the stub's `complete` is not invoked for the blocked request;
 *   - a different IP is unaffected by the first IP's budget (per-IP isolation);
 *   - a valid request within budget still returns 201;
 *   - spamming `/state` does not consume the `/complete` budget (independent
 *     buckets).
 *
 * **Validates: Requirements 1, 2, 3 of setup-complete-rate-brake**
 */

// Mirror of the handler constant; kept in sync with routes.ts.
const COMPLETE_RATE_LIMIT = 10;

type SetupOverride = NonNullable<AppEnv['Variables']['setupServiceOverride']>;

function makeStubService(): { service: SetupOverride; calls: () => number } {
  let completeCalls = 0;
  const service: SetupOverride = {
    async complete() {
      completeCalls += 1;
      return { ok: true, value: { adminPath: '/lumi-abc123' } };
    },
  };
  return { service, calls: () => completeCalls };
}

function buildApp(service?: SetupOverride, db: unknown = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db as never);
    c.set('requestId', 'req_test');
    if (service) c.set('setupServiceOverride', service);
    await next();
  });
  app.route('/api/v1/setup', setupRouter);
  return app;
}

const TEST_ENV = {
  LUMIBASE_ENV: 'development',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
} as unknown as AppEnv['Bindings'];

const VALID_BODY = {
  account: {
    email: 'admin@example.com',
    password: 'Sup3r$ecret!Pass',
    firstName: 'Ada',
    lastName: 'Lovelace',
  },
  adminPath: '/lumi-abc123',
};

function postComplete(
  app: Hono<AppEnv>,
  body: unknown,
  ip: string,
): Promise<Response> {
  return Promise.resolve(
    app.request(
      '/api/v1/setup/complete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify(body),
      },
      TEST_ENV,
    ),
  );
}

function getState(app: Hono<AppEnv>, ip: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      '/api/v1/setup/state',
      { method: 'GET', headers: { 'cf-connecting-ip': ip } },
      TEST_ENV,
    ),
  );
}

beforeEach(() => {
  __resetSetupRateLimitForTests();
});

describe('POST /setup/complete — per-IP rate brake', () => {
  it('throttles once an IP exceeds the limit, without invoking the service', async () => {
    const stub = makeStubService();
    const app = buildApp(stub.service);
    const ip = '203.0.113.10';

    // First COMPLETE_RATE_LIMIT requests are allowed through to the service.
    for (let i = 0; i < COMPLETE_RATE_LIMIT; i += 1) {
      const res = await postComplete(app, VALID_BODY, ip);
      expect(res.status).toBe(201);
    }
    expect(stub.calls()).toBe(COMPLETE_RATE_LIMIT);

    // The next one is blocked *before* the service runs.
    const blocked = await postComplete(app, VALID_BODY, ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    const bodyJson = (await blocked.json()) as { errors: { code: string }[] };
    expect(bodyJson.errors[0]?.code).toBe('RATE_LIMITED');
    // Service call count did not increase for the throttled request.
    expect(stub.calls()).toBe(COMPLETE_RATE_LIMIT);
  });

  it('does not leak version / hostname / tenant id in the 429 body', async () => {
    const app = buildApp(makeStubService().service);
    const ip = '203.0.113.11';
    for (let i = 0; i < COMPLETE_RATE_LIMIT; i += 1) {
      await postComplete(app, VALID_BODY, ip);
    }
    const blocked = await postComplete(app, VALID_BODY, ip);
    const bodyJson = (await blocked.json()) as Record<string, unknown>;
    expect(Object.keys(bodyJson)).toEqual(['errors']);
  });

  it('isolates the budget per IP', async () => {
    const stub = makeStubService();
    const app = buildApp(stub.service);
    const hot = '203.0.113.12';
    const other = '203.0.113.13';

    // Exhaust the hot IP.
    for (let i = 0; i < COMPLETE_RATE_LIMIT; i += 1) {
      await postComplete(app, VALID_BODY, hot);
    }
    expect((await postComplete(app, VALID_BODY, hot)).status).toBe(429);

    // A different IP is untouched.
    expect((await postComplete(app, VALID_BODY, other)).status).toBe(201);
  });

  it('lets a valid request within budget through to 201', async () => {
    const stub = makeStubService();
    const app = buildApp(stub.service);
    const res = await postComplete(app, VALID_BODY, '203.0.113.14');
    expect(res.status).toBe(201);
    expect(stub.calls()).toBe(1);
  });

  it('keeps the /complete and /state buckets independent', async () => {
    const stub = makeStubService();
    const app = buildApp(stub.service);
    const ip = '203.0.113.15';

    // Hammer /state well past the /complete limit. /state hits its own
    // bucket (limit 60) — the stub db has no `.select`, so it 500s, but a
    // 500 still means the request passed the /state brake, never the
    // /complete one. We only care that it does NOT drain /complete's budget.
    for (let i = 0; i < COMPLETE_RATE_LIMIT + 5; i += 1) {
      const res = await getState(app, ip);
      expect(res.status).not.toBe(429);
    }

    // /complete from the same IP is still on a fresh budget → 201, not 429.
    const res = await postComplete(app, VALID_BODY, ip);
    expect(res.status).toBe(201);
  });
});
