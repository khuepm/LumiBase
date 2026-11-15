import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { systemState, users, type Database } from '@lumibase/database';

import type { AppEnv } from '../../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { setupRouter, __resetSetupRateLimitForTests } from '../routes';

/**
 * #732 (epic #674 S03) — parallel first-admin registration, end to end.
 *
 * Strapi #26494 was a missing rate limit *and* a race on `register-admin`:
 * two requests landing in the pre-initialized window could both create an
 * admin. Here N requests hit the real `POST /api/v1/setup/complete` handler,
 * backed by the real `SetupService` on Postgres, at the same time. Each comes
 * from its own client IP so the per-IP brake (spec
 * `setup-complete-rate-brake`) stays out of the way: this suite is about the
 * database guarantee, not the brake.
 *
 * Acceptance: exactly one 201, every other request 409, and exactly one
 * `is_bootstrap` row — whatever account each loser tried to create.
 *
 * The concurrency needs the real database: the guarantee is the singleton's
 * `SELECT … FOR UPDATE`, the `users_is_bootstrap_unique` partial index and the
 * state machine, which a fake can only restate.
 *
 * Skips without DATABASE_URL (see `__tests__/helpers/db-harness.ts`).
 */

const N = 8;

const TEST_ENV = {} as unknown as AppEnv['Bindings'];

function buildApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('requestId', 'req_setup_race');
    await next();
  });
  app.route('/api/v1/setup', setupRouter);
  return app;
}

function body(i: number, sameAccount: boolean) {
  return {
    account: {
      email: sameAccount ? 'admin@example.com' : `admin-${i}@example.com`,
      password: 'CorrectHorseBatteryStaple!42',
      firstName: 'Ada',
      lastName: `Racer ${i}`,
    },
    adminPath: `/lumi-race-${i}x7q`,
  };
}

async function fire(app: Hono<AppEnv>, i: number, sameAccount: boolean): Promise<Response> {
  return app.request(
    '/api/v1/setup/complete',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${i + 1}` },
      body: JSON.stringify(body(i, sameAccount)),
    },
    TEST_ENV,
  );
}

describe.skipIf(!hasDbIntegrationUrl)('POST /setup/complete — parallel first-admin race (Postgres)', () => {
  let db: Database;

  const reset = async (): Promise<void> => {
    await db.execute(
      sql`TRUNCATE TABLE lumibase_admin_backup_codes, lumibase_audit_log, lumibase_system_state, lumibase_users, lumibase_sites RESTART IDENTITY CASCADE`,
    );
  };

  beforeAll(async () => {
    db = await connectDbIntegration('setup-complete-race');
  });

  afterAll(async () => {
    if (!db) return;
    await reset().catch(() => undefined);
  });

  beforeEach(async () => {
    __resetSetupRateLimitForTests();
    await reset();
  });

  it.each([
    ['distinct accounts', false],
    ['the same account', true],
  ])('N parallel requests for %s yield exactly one admin; the rest 409', async (_label, sameAccount) => {
    const app = buildApp(db);
    const responses = await Promise.all(Array.from({ length: N }, (_, i) => fire(app, i, sameAccount)));
    const statuses = responses.map((r) => r.status);

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(N - 1);

    for (const res of responses) {
      if (res.status !== 409) continue;
      const json = (await res.json()) as { errors: Array<{ code: string }> };
      expect(['SETUP_ALREADY_COMPLETED', 'SETUP_IN_PROGRESS']).toContain(json.errors[0]?.code);
    }

    const admins = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.isBootstrap, true));
    expect(admins).toHaveLength(1);
    // Losers left no account behind — their whole transaction rolled back.
    const all = await db.select({ id: users.id }).from(users);
    expect(all).toHaveLength(1);

    const [state] = await db.select().from(systemState).where(eq(systemState.id, 'singleton'));
    expect(state?.state).toBe('initialized');
  });

  it('a request arriving after setup finished still sees an indistinguishable 404', async () => {
    const app = buildApp(db);
    expect((await fire(app, 0, false)).status).toBe(201);
    const late = await fire(app, 1, false);
    expect(late.status).toBe(404);
    expect(await late.json()).toEqual({ errors: [{ code: 'NOT_FOUND' }] });
  });

  it('the partial unique index refuses a second bootstrap admin even outside the service', async () => {
    await db.insert(users).values({ email: 'first@example.com', status: 'active', isBootstrap: true });
    await expect(
      db.insert(users).values({ email: 'second@example.com', status: 'active', isBootstrap: true }),
    ).rejects.toThrow();
    const admins = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true));
    expect(admins).toHaveLength(1);
  });
});
