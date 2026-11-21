import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { apiKeys, settings, sites, users, type Database } from '@lumibase/database';
import { MemoryRateLimiter } from '@lumibase/runtime';

import type { AppEnv } from '../env';
import { STANDARD_LOCKOUT_POLICY } from '../modules/setup/policy-codec';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * #994 end to end: a login re-hashes a password stored below the configured
 * work factor, a closed site refuses self-registration before doing any work,
 * and `GET /api-keys/unused` lists the live keys nobody has used lately.
 */

const { authRouter } = await import('../routes/auth');
const { apiKeysRouter } = await import('../routes/api-keys');
const { SetupService } = await import('../modules/setup/service');

const JWT_SECRET = 'test-secret-do-not-use-in-prod';
const EMAIL = 'cred-defaults@example.com';
const PASSWORD = 'CorrectHorseBatteryStaple!42';

describe.skipIf(!hasDbIntegrationUrl)('credential defaults — DB integration', () => {
  let db: Database;
  let siteId: string;
  let userId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('credential-defaults');
  });

  beforeEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE lumibase_login_attempts, lumibase_login_baselines, lumibase_audit_log, lumibase_refresh_tokens, lumibase_system_state, lumibase_settings, lumibase_api_keys, lumibase_user_sites, lumibase_sites, lumibase_users RESTART IDENTITY CASCADE`,
    );
    const outcome = await new SetupService({ db, requireSetupToken: false, smtpAvailable: false, encryptionAvailable: true }).complete(
      {
        account: { email: EMAIL, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace' },
        adminPath: '/lumi-9c3a7f',
        policy: { ...STANDARD_LOCKOUT_POLICY, notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels] },
      },
      { requestId: 'req-seed', ip: '127.0.0.1', userAgent: 'vitest' },
    );
    if (!outcome.ok) throw new Error('setup failed');
    userId = outcome.value.user.id;
    siteId = (await db.select({ id: sites.id }).from(sites).limit(1))[0]!.id;
  });

  function app(auth?: Record<string, unknown>) {
    const a = new Hono<AppEnv>();
    const limiter = new MemoryRateLimiter();
    a.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('runtime', { rateLimiter: limiter } as never);
      c.set('requestId', 'req');
      if (auth) c.set('auth', auth as never);
      await next();
    });
    a.route('/auth', authRouter);
    a.route('/api-keys', apiKeysRouter);
    return a;
  }

  const post = (a: Hono<AppEnv>, path: string, body: unknown, env: Record<string, string> = {}) =>
    a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify(body) }, { JWT_SECRET, ...env } as never);

  it('re-hashes a password stored below the target work factor on login', async () => {
    const before = (await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, userId)))[0]!.h!;
    expect(before.split('$')[1]).toBe('100000');
    const res = await post(app(), '/auth/login', { email: EMAIL, password: PASSWORD }, { PASSWORD_PBKDF2_ITERATIONS: '150000' });
    expect(res.status).toBe(200);
    const after = (await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, userId)))[0]!.h!;
    expect(after.split('$')[1]).toBe('150000');
    // And the user can still sign in with the same password.
    expect((await post(app(), '/auth/login', { email: EMAIL, password: PASSWORD }, { PASSWORD_PBKDF2_ITERATIONS: '150000' })).status).toBe(200);
  });

  it('refuses self-registration on a closed site, creating nothing', async () => {
    await db.insert(settings).values({ siteId, key: 'auth.registration', value: { enabled: false } });
    const res = await post(app(), '/auth/register', { email: 'new@example.com', password: PASSWORD });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('REGISTRATION_DISABLED');
    expect(await db.select().from(users).where(eq(users.email, 'new@example.com'))).toHaveLength(0);
  });

  it('lists live keys unused for N days', async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await db.insert(apiKeys).values([
      { siteId, name: 'never-used', prefix: 'lbk_a', tokenHash: 'h1' },
      { siteId, name: 'stale', prefix: 'lbk_b', tokenHash: 'h2', lastUsedAt: old },
      { siteId, name: 'fresh', prefix: 'lbk_c', tokenHash: 'h3', lastUsedAt: recent },
      { siteId, name: 'revoked', prefix: 'lbk_d', tokenHash: 'h4', revokedAt: new Date() },
      { siteId, name: 'expired', prefix: 'lbk_e', tokenHash: 'h5', expiresAt: old },
    ]);
    const res = await app({ userId, roles: ['admin'], raw: {} }).request('/api-keys/unused?days=90', {}, { JWT_SECRET } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string }>; meta: { days: number } };
    expect(body.data.map((k) => k.name).sort()).toEqual(['never-used', 'stale']);
    expect(body.meta.days).toBe(90);
  });

  it('gives a key created without expiresAt the default lifetime', async () => {
    const res = await post(app({ userId, roles: ['admin'], raw: {} }), '/api-keys', { name: 'ci' });
    expect(res.status).toBe(201);
    const [row] = await db.select({ expiresAt: apiKeys.expiresAt }).from(apiKeys).where(eq(apiKeys.name, 'ci'));
    const days = (row!.expiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);
  });
});
