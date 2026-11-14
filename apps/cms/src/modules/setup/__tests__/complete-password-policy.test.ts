import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import type { AppEnv } from '../../../env';
import { setupRouter, __resetSetupRateLimitForTests } from '../routes';

/**
 * `POST /api/v1/setup/complete` enforces the password policy (#733) through
 * the shared service and reports each failed rule — the setup wizard's
 * bootstrap admin is one of the password-setting paths. The service is a stub
 * so a rejected request can be shown never to reach it.
 */

type SetupOverride = NonNullable<AppEnv['Variables']['setupServiceOverride']>;

function build(): { app: Hono<AppEnv>; calls: () => number } {
  let calls = 0;
  const service: SetupOverride = {
    async complete() {
      calls += 1;
      return { ok: true, value: { adminPath: '/lumi-abc123' } };
    },
  };
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', {} as never);
    c.set('requestId', 'req_test');
    c.set('setupServiceOverride', service);
    await next();
  });
  app.route('/api/v1/setup', setupRouter);
  return { app, calls: () => calls };
}

const TEST_ENV = {
  LUMIBASE_ENV: 'development',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test',
} as unknown as AppEnv['Bindings'];

function complete(app: Hono<AppEnv>, password: string, ip: string) {
  return app.request(
    '/api/v1/setup/complete',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify({
        account: { email: 'ada@example.com', password, firstName: 'Ada', lastName: 'Lovelace' },
        adminPath: '/lumi-abc123',
      }),
    },
    TEST_ENV,
  );
}

beforeEach(() => __resetSetupRateLimitForTests());

describe('POST /setup/complete — password policy', () => {
  it('rejects a weak password with PASSWORD_POLICY naming the failed rules', async () => {
    const { app, calls } = build();
    const res = await complete(app, 'adalovelace', '203.0.113.50');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string; rules: Array<{ rule: string; ok: boolean }> }> };
    expect(body.errors[0]!.code).toBe('PASSWORD_POLICY');
    expect(body.errors[0]!.rules.filter((r) => !r.ok).map((r) => r.rule)).toEqual([
      'min_length',
      'uppercase',
      'digit',
      'special',
      'min_strength',
    ]);
    expect(calls()).toBe(0);
  });

  it("counts the admin's own e-mail against the strength score", async () => {
    const { app } = build();
    const res = await complete(app, 'Ada@example.com1', '203.0.113.51');
    expect(res.status).toBe(400);
  });

  it('passes a compliant password to the service', async () => {
    const { app, calls } = build();
    const res = await complete(app, 'Sup3r$ecret!Pass', '203.0.113.52');
    expect(res.status).toBe(201);
    expect(calls()).toBe(1);
  });
});
