import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { organizations, sites, users, type Database } from '@lumibase/database';
import { MemoryCacheProvider, MemoryRateLimiter } from '@lumibase/runtime';

import type { AppEnv } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { authRouter } from '../auth';
import { withTenant } from '../../middleware/tenant';
import { hashPassword, verifyPassword } from '../../services/auth/password';
import { provisionSite } from '../../services/site-provisioning';
import { signVerificationToken } from '../../services/auth/email-verification';
import { signPasswordResetToken } from '../../services/auth/password-reset';
import { consumeEmailVerification, consumePasswordReset } from '../../services/auth/single-use-consume';

/**
 * #732 (epic #674 S03) — the single-use account links are single-winner under
 * concurrency, on Postgres.
 *
 * The verification and reset links are stateless JWTs, so "single use" is the
 * account state they move. N requests carrying the same link hit the real
 * `authRouter` at once (each from its own IP, so the per-IP brake stays out of
 * the way); exactly one may succeed. The guarantee is a conditional `UPDATE …
 * RETURNING` — a property of Postgres row locking a fake can only restate.
 *
 * Skips without DATABASE_URL (see `__tests__/helpers/db-harness.ts`).
 */

const ORG = 'org_732_single_use';
const SITE = 'site_732_single_use';
const USER = 'user_732_single_use';
const EMAIL = 'single-use-732@example.test';
const SECRET = 'single-use-race-signing-test-only';
const N = 6;

describe.skipIf(!hasDbIntegrationUrl)('single-use auth links under concurrency (Postgres)', () => {
  let db: Database;
  let app: Hono<AppEnv>;

  const clean = async (): Promise<void> => {
    await db.delete(sites).where(inArray(sites.id, [SITE]));
    await db.delete(organizations).where(eq(organizations.id, ORG));
    await db.delete(users).where(eq(users.id, USER));
  };

  const post = (path: string, body: unknown, i: number): Promise<Response> =>
    Promise.resolve(
      app.request(
        `/api/v1/auth/${path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Lumi-Site': SITE,
            'cf-connecting-ip': `192.0.2.${i + 1}`,
          },
          body: JSON.stringify(body),
        },
        { JWT_SECRET: SECRET } as AppEnv['Bindings'],
      ),
    );

  const readUser = async () => {
    const [row] = await db
      .select({ status: users.status, tokenVersion: users.tokenVersion, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, USER));
    return row;
  };

  beforeAll(async () => {
    db = await connectDbIntegration('auth-single-use-race');
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('runtime', { cache: new MemoryCacheProvider(), rateLimiter: new MemoryRateLimiter() } as never);
      await next();
    });
    app.use('*', withTenant());
    app.route('/api/v1/auth', authRouter);
  });

  beforeEach(async () => {
    await clean();
    await db.insert(organizations).values({ id: ORG, slug: ORG, name: 'Single use 732' });
    await provisionSite(db, { id: SITE, name: 'Single use site', organizationId: ORG });
  });

  afterAll(async () => {
    if (db) await clean();
  });

  it('N parallel /verify-email with one link: exactly one verifies, the rest read already_verified', async () => {
    await db.insert(users).values({
      id: USER,
      email: EMAIL,
      passwordHash: await hashPassword('Single-Use-Verify-732!'),
      status: 'invited',
    });
    const token = await signVerificationToken({ userId: USER, siteId: SITE }, SECRET);

    const responses = await Promise.all(Array.from({ length: N }, (_, i) => post('verify-email', { token }, i)));
    expect(responses.map((r) => r.status)).toEqual(Array.from({ length: N }, () => 200));
    const statuses = await Promise.all(
      responses.map(async (r) => ((await r.json()) as { data: { status: string } }).data.status),
    );
    expect(statuses.filter((s) => s === 'verified')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'already_verified')).toHaveLength(N - 1);
    expect((await readUser())?.status).toBe('active');
  });

  it('N parallel /reset-password with one link: exactly one password is set, the rest are refused', async () => {
    await db.insert(users).values({
      id: USER,
      email: EMAIL,
      passwordHash: await hashPassword('Original-Password-732!'),
      status: 'active',
    });
    const token = await signPasswordResetToken({ userId: USER, siteId: SITE }, SECRET);
    const passwords = Array.from({ length: N }, (_, i) => `Racing-Password-732-${i}!`);

    const responses = await Promise.all(passwords.map((password, i) => post('reset-password', { token, password }, i)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 400)).toHaveLength(N - 1);
    for (const res of responses) {
      if (res.status !== 400) continue;
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]?.code).toBe('INVALID_TOKEN');
    }

    // One write, one generation bump — and the stored hash is the winner's.
    const after = await readUser();
    expect(after?.tokenVersion).toBe(1);
    const winner = passwords[statuses.indexOf(200)]!;
    expect(await verifyPassword(winner, after?.passwordHash ?? '')).toBe(true);
  });

  it('the reset compare-and-swap lets exactly one of two writers with the same version through', async () => {
    await db.insert(users).values({ id: USER, email: EMAIL, passwordHash: 'old', status: 'active' });
    // Both callers validated the token against token_version = 0.
    const results = await Promise.all([
      consumePasswordReset(db, { userId: USER, expectedTokenVersion: 0, passwordHash: 'hash-a' }),
      consumePasswordReset(db, { userId: USER, expectedTokenVersion: 0, passwordHash: 'hash-b' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await readUser();
    expect(after?.tokenVersion).toBe(1);
    expect(after?.passwordHash).toBe(results[0] ? 'hash-a' : 'hash-b');
  });

  it('the reset compare-and-swap refuses a suspended account', async () => {
    await db.insert(users).values({ id: USER, email: EMAIL, passwordHash: 'old', status: 'suspended' });
    expect(await consumePasswordReset(db, { userId: USER, expectedTokenVersion: 0, passwordHash: 'new' })).toBe(false);
    expect((await readUser())?.passwordHash).toBe('old');
  });

  it('the verification flip has one winner and classifies the losers', async () => {
    await db.insert(users).values({ id: USER, email: EMAIL, status: 'invited' });
    const outcomes = await Promise.all(Array.from({ length: N }, () => consumeEmailVerification(db, USER)));
    expect(outcomes.filter((o) => o === 'verified')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already_verified')).toHaveLength(N - 1);
    expect(await consumeEmailVerification(db, 'user_732_missing')).toBe('not_found');
  });
});
