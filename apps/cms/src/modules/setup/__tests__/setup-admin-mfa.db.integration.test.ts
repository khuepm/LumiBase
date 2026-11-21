import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { policies, rolePolicies, roles, type Database } from '@lumibase/database';

import type { AppEnv } from '../../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { setupRouter, __resetSetupRateLimitForTests } from '../routes';
import { ADMINISTRATOR_MFA_POLICY_KEY, ensureAdministratorMfaPolicy } from '../../../services/site-provisioning';

/**
 * #987 — setup binds an `enforceTfa` "Administrator MFA" policy to the
 * Administrator role when `LUMIBASE_ADMIN_REQUIRE_MFA` (or production with
 * encryption) says so, and binds nothing otherwise.
 *
 * Skips without DATABASE_URL (see `__tests__/helpers/db-harness.ts`).
 */

function buildApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('requestId', 'req_setup_admin_mfa');
    await next();
  });
  app.route('/api/v1/setup', setupRouter);
  return app;
}

async function runSetup(db: Database, env: Record<string, string>): Promise<Response> {
  return buildApp(db).request(
    '/api/v1/setup/complete',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
      body: JSON.stringify({
        account: { email: 'admin@example.com', password: 'CorrectHorseBatteryStaple!42', firstName: 'Ada', lastName: 'Admin' },
        adminPath: '/lumi-mfa-x7q',
      }),
    },
    env as unknown as AppEnv['Bindings'],
  );
}

async function administratorMfaBinding(db: Database) {
  return db
    .select({ enforceTfa: policies.enforceTfa, adminAccess: policies.adminAccess, appAccess: policies.appAccess })
    .from(rolePolicies)
    .innerJoin(policies, eq(policies.id, rolePolicies.policyId))
    .innerJoin(roles, eq(roles.id, rolePolicies.roleId))
    .where(and(eq(roles.systemKey, 'administrator'), eq(policies.key, ADMINISTRATOR_MFA_POLICY_KEY)));
}

describe.skipIf(!hasDbIntegrationUrl)('setup — Administrator MFA policy (Postgres)', () => {
  let db: Database;

  const reset = async (): Promise<void> => {
    await db.execute(
      sql`TRUNCATE TABLE lumibase_admin_backup_codes, lumibase_audit_log, lumibase_system_state, lumibase_users, lumibase_sites RESTART IDENTITY CASCADE`,
    );
  };

  beforeAll(async () => {
    db = await connectDbIntegration('setup-admin-mfa');
  });
  afterAll(async () => {
    if (db) await reset().catch(() => undefined);
  });
  beforeEach(async () => {
    __resetSetupRateLimitForTests();
    await reset();
  });

  it('binds an enforceTfa policy that grants nothing when the operator asks for it', async () => {
    expect((await runSetup(db, { LUMIBASE_ADMIN_REQUIRE_MFA: 'true' })).status).toBe(201);
    expect(await administratorMfaBinding(db)).toEqual([{ enforceTfa: true, adminAccess: false, appAccess: false }]);
  });

  it('binds nothing when the operator opts out', async () => {
    expect((await runSetup(db, { LUMIBASE_ADMIN_REQUIRE_MFA: 'false', LUMIBASE_ENV: 'production', LUMIBASE_REQUIRE_SETUP_TOKEN: 'false' })).status).toBe(201);
    expect(await administratorMfaBinding(db)).toEqual([]);
  });

  it('is idempotent for the policy and the binding', async () => {
    expect((await runSetup(db, { LUMIBASE_ADMIN_REQUIRE_MFA: 'true' })).status).toBe(201);
    const [admin] = await db.select({ id: roles.id, siteId: roles.siteId }).from(roles).where(eq(roles.systemKey, 'administrator'));
    const first = await ensureAdministratorMfaPolicy(db, admin!.siteId, admin!.id);
    const second = await ensureAdministratorMfaPolicy(db, admin!.siteId, admin!.id);
    expect(second).toBe(first);
    expect(await administratorMfaBinding(db)).toHaveLength(1);
  });
});
