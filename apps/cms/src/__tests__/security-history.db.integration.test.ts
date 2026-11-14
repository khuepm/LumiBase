import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { auditLog, loginBaselines, sites, type Database } from '@lumibase/database';
import { MemoryRateLimiter } from '@lumibase/runtime';

import type { AppEnv } from '../env';
import { STANDARD_LOCKOUT_POLICY, type LockoutPolicy } from '../modules/setup/policy-codec';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * #739 end to end on a real Postgres: password sign-ins through the
 * production `/auth/login` route learn devices in `login_baselines`, a sign-in
 * from an unseen device sends the new-device email (detached) and records a
 * `new_device_login` audit event, and `GET /me/security-history` returns the
 * caller's own events only.
 */

const send = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ attempted: true, ok: true })),
);
vi.mock('../modules/email/new-device-login', () => ({ sendNewDeviceLoginEmail: send }));

const { authRouter } = await import('../routes/auth');
const { securityHistoryRouter } = await import('../modules/security-history/routes');
const { SetupService } = await import('../modules/setup/service');

const JWT_SECRET = 'test-secret-do-not-use-in-prod';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'CorrectHorseBatteryStaple!42';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';

function freshStandardPolicy(): LockoutPolicy {
  return { ...STANDARD_LOCKOUT_POLICY, notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels] };
}

describe.skipIf(!hasDbIntegrationUrl)('Security history — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('security-history');
  });

  beforeEach(async () => {
    send.mockClear();
    await db.execute(
      sql`TRUNCATE TABLE lumibase_login_attempts, lumibase_login_baselines, lumibase_audit_log, lumibase_refresh_tokens, lumibase_system_state, lumibase_settings, lumibase_user_sites, lumibase_sites, lumibase_users RESTART IDENTITY CASCADE`,
    );
  });

  async function seedBootstrapAdmin(): Promise<string> {
    const svc = new SetupService({ db, requireSetupToken: false, smtpAvailable: false, encryptionAvailable: true });
    const outcome = await svc.complete(
      {
        account: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
        adminPath: '/lumi-7f3a9c',
        policy: freshStandardPolicy(),
      },
      { requestId: 'req-seed', ip: '127.0.0.1', userAgent: 'vitest' },
    );
    if (!outcome.ok) throw new Error('seedBootstrapAdmin failed');
    return outcome.value.user.id;
  }

  function buildApp(siteId: string, auth?: Record<string, unknown>): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    const limiter = new MemoryRateLimiter();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('runtime', { rateLimiter: limiter } as never);
      c.set('requestId', `req_${Math.random().toString(36).slice(2)}`);
      if (auth) c.set('auth', auth as never);
      await next();
    });
    app.route('/auth', authRouter);
    app.route('/me/security-history', securityHistoryRouter);
    return app;
  }

  const login = (app: Hono<AppEnv>, ua: string) =>
    app.request(
      '/auth/login',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '203.0.113.77',
          'user-agent': ua,
          'accept-language': 'en-US',
        },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      },
      { JWT_SECRET } as AppEnv['Bindings'],
    );

  it('emails once for a new device, learns it, and lists the caller\'s own history', async () => {
    const userId = await seedBootstrapAdmin();
    const [site] = await db.select({ id: sites.id }).from(sites).limit(1);
    const app = buildApp(site!.id);

    // First ever sign-in and a repeat from the same Mac: nothing to report.
    expect((await login(app, UA_MAC)).status).toBe(200);
    expect((await login(app, UA_MAC)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(send).not.toHaveBeenCalled();
    const [baseline] = await db.select().from(loginBaselines).where(eq(loginBaselines.userId, userId));
    expect((baseline!.deviceFingerprints as unknown[]).length).toBe(1);

    // A sign-in from an Android phone: one email, well inside a minute.
    const started = Date.now();
    expect((await login(app, UA_ANDROID)).status).toBe(200);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(send.mock.calls[0]![0]).toMatchObject({ email: ADMIN_EMAIL, deviceLabel: 'Chrome on Android', ipApprox: '203.0.113.x' });
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.event, 'new_device_login'), eq(auditLog.siteId, site!.id)));
      expect(rows).toHaveLength(1);
    });

    // The phone is now known.
    expect((await login(app, UA_ANDROID)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(send).toHaveBeenCalledTimes(1);

    // Someone else's event on the same site never shows up.
    await db.insert(auditLog).values({
      id: 'other-1',
      siteId: site!.id,
      event: 'login_success',
      actorEmail: 'other@example.com',
      targetEmail: 'other@example.com',
      metadata: {},
    });

    const res = await buildApp(site!.id, { userId, email: ADMIN_EMAIL, roles: ['admin'] }).request(
      '/me/security-history?limit=100',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; kind: string; details: Record<string, unknown> }> };
    const kinds = body.data.map((i) => i.kind);
    expect(kinds.filter((k) => k === 'sign_in')).toHaveLength(4);
    expect(kinds.filter((k) => k === 'new_device')).toHaveLength(1);
    expect(body.data.some((i) => i.id === 'other-1')).toBe(false);
    expect(body.data.find((i) => i.kind === 'sign_in')?.details).toEqual({ method: 'password' });
  });
});
