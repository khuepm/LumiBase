import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import { MemoryRateLimiter } from '@lumibase/runtime';
import type { AppEnv } from '../../env';

/**
 * #739 — a TOTP sign-in from a device the account has not used before sends
 * the new-device email (detached from the response), records the sign-in
 * with `method: 'totp'` and the device in the baseline; a known device sends
 * nothing. The password path is covered end to end in
 * `__tests__/security-history.db.integration.test.ts`.
 */

const UA_NEW = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';

const svc = vi.hoisted(() => ({
  send: vi.fn(),
  audit: vi.fn(),
  recordLoginSuccess: vi.fn(),
  knownFingerprints: [] as string[],
}));

vi.mock('../../services/auth/mfa-challenge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/mfa-challenge')>();
  return {
    ...actual,
    verifyMfaChallengeToken: async () => ({ userId: 'usr_1', siteId: 'site-a', loginAudience: 'studio', jti: 'j1' }),
  };
});

vi.mock('../../modules/mfa/totp-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/mfa/totp-service')>();
  return { ...actual, consumeMfaChallengeJti: async () => true, verifyUserTotpCode: async () => true };
});

vi.mock('../../modules/login-guard/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/login-guard/hooks')>();
  return { ...actual, recordLoginSuccess: svc.recordLoginSuccess };
});

vi.mock('../../services/auth/login-session', () => ({
  completePasswordLoginSession: (c: { json: (b: unknown, s?: number) => Response }) =>
    c.json({ data: { token: 't' } }),
}));

vi.mock('../../modules/anomaly/device', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/anomaly/device')>();
  return {
    ...actual,
    loadDeviceBaselineFromDb: async () => ({
      successfulLogins: 4,
      deviceFingerprints: svc.knownFingerprints.map((fp) => ({ fp, lastSeenAt: '2026-11-01T00:00:00Z' })),
    }),
  };
});

vi.mock('../../modules/email/new-device-login', () => ({ sendNewDeviceLoginEmail: svc.send }));

vi.mock('../../modules/audit/logger', () => ({
  AuditLogger: class {
    write(entry: unknown) {
      svc.audit(entry);
      return Promise.resolve();
    }
  },
}));

const { tfaAuthRouter } = await import('../tfa');
const { fingerprint } = await import('../../modules/anomaly/device');

const user = { id: 'usr_1', email: 'Me@Example.com', status: 'active', tokenVersion: 0 };
const db = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [user] }) }) }),
} as unknown as Database;

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('siteId', 'site-a');
    c.set('runtime', { cache: {}, keys: {}, rateLimiter: new MemoryRateLimiter() } as never);
    await next();
  });
  app.route('/api/v1/auth', tfaAuthRouter);
  return app;
}

const verify = (ua: string) =>
  buildApp().request(
    '/api/v1/auth/verify-totp',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': ua,
        'accept-language': 'vi-VN',
        'cf-connecting-ip': '203.0.113.77',
      },
      body: JSON.stringify({ challengeToken: 'x'.repeat(40), code: '123456' }),
    },
    { JWT_SECRET: 'test-secret' } as AppEnv['Bindings'],
  );

beforeEach(() => {
  svc.send.mockReset();
  svc.audit.mockReset();
  svc.recordLoginSuccess.mockReset();
  svc.send.mockResolvedValue({ attempted: true, ok: true });
  svc.knownFingerprints = ['0123456789abcdef'];
});

describe('POST /auth/verify-totp — new-device notification', () => {
  it('emails the owner within the minute, without blocking the response', async () => {
    const started = Date.now();
    const res = await verify(UA_NEW);
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(svc.send).toHaveBeenCalledTimes(1), { timeout: 5_000 });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(svc.send).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'Me@Example.com',
        siteId: 'site-a',
        audience: 'studio',
        ipApprox: '203.0.113.x',
        deviceLabel: 'Chrome on Android',
      }),
    );
    await vi.waitFor(() =>
      expect(svc.audit).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'new_device_login', metadata: expect.objectContaining({ notified: true }) }),
      ),
    );

    // The success hook records the sign-in as TOTP, audits it, and gets the
    // fingerprint so the baseline learns this device.
    const [, ctx, options] = svc.recordLoginSuccess.mock.calls[0]!;
    expect(ctx).toMatchObject({ method: 'totp', userId: 'usr_1' });
    expect(ctx.attempt.deviceFingerprint).toBe(await fingerprint(UA_NEW, 'vi-VN'));
    expect(options.notify.audit).toBeDefined();
  });

  it('sends nothing for a device already in the baseline', async () => {
    svc.knownFingerprints = [await fingerprint(UA_NEW, 'vi-VN')];
    const res = await verify(UA_NEW);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(svc.send).not.toHaveBeenCalled();
    expect(svc.audit).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'new_device_login' }));
  });
});
