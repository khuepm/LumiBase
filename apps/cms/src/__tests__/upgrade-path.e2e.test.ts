import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import {
  LEGACY_POLICY_KEY_PREFIX,
  backfillRolePolicyFlags,
  createDb,
  findUnbackfilledRoles,
  policies,
  rolePolicies,
  roles,
  rollbackRolePolicyBackfill,
  sites,
  type Database,
} from '@lumibase/database';

/**
 * Upgrade-path E2E gate (v1 release criteria §4).
 *
 * "Upgrading to 1.0" (docs/en/operations/upgrades.md) promises that a
 * `0.6.x`–`0.17.x` instance upgrades in place via the RBAC role→policy
 * backfill, with a zero-row post-check. This test is the automated evidence:
 * it seeds the exact pre-policy data shape such an instance carries — roles
 * whose `admin_access`/`app_access` live only as role flags, with NO policy
 * rows — then runs the real backfill (the same code the
 * `backfill:role-policies` script runs) against a real Postgres and asserts
 * the documented contract:
 *
 *   1. every legacy-flag role gains one flag-only policy with the EXACT flag
 *      values (admin-only and app-only roles are not conflated),
 *   2. the documented post-check returns zero rows,
 *   3. roles without legacy flags get nothing,
 *   4. the backfill is idempotent (re-run converges, no duplicates),
 *   5. role flags are never mutated (rollback anchor), and
 *   6. the compat-window rollback removes the backfill cleanly.
 *
 * Same skip pattern as golden-path: runs when DATABASE_URL is reachable; the
 * CI `e2e-golden-path` job (Postgres service + migrations applied) is where
 * it actually executes.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL;

const SITE = 'site_upgrade_path_e2e';

// The four flag shapes a real 0.6.x instance can contain. Exact values must
// survive the backfill — no `admin => app` inference.
const FIXTURE_ROLES = [
  { id: 'upg_role_admin', name: 'Upg Legacy Admin', systemKey: 'upg_administrator', adminAccess: true, appAccess: true },
  { id: 'upg_role_app', name: 'Upg App Only', systemKey: 'upg_app_only', adminAccess: false, appAccess: true },
  { id: 'upg_role_api', name: 'Upg API Admin', systemKey: 'upg_api_admin', adminAccess: true, appAccess: false },
  { id: 'upg_role_none', name: 'Upg No Access', systemKey: 'upg_no_access', adminAccess: false, appAccess: false },
] as const;

describe('Upgrade path 0.6.x → 1.0: RBAC role→policy backfill', () => {
  let db: Database;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      console.warn('Skipping upgrade-path E2E: DATABASE_URL not set.');
      return;
    }
    try {
      db = createDb(TEST_DATABASE_URL);
      await db.execute(sql`SELECT 1`);
      canConnect = true;
    } catch {
      console.warn('Skipping upgrade-path E2E: database not reachable.');
      canConnect = false;
    }
    if (!canConnect) return;
    await resetFixture();
    await seedLegacyInstance();
  });

  afterAll(async () => {
    if (!canConnect) return;
    await resetFixture();
  });

  // Site delete cascades into roles → role_policies and policies.
  async function resetFixture(): Promise<void> {
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  }

  /** Pre-policy (0.6.x-shape) fixture: role flags only, zero policy rows. */
  async function seedLegacyInstance(): Promise<void> {
    await db.insert(sites).values({ id: SITE, name: 'Upgrade Path E2E' });
    await db.insert(roles).values(
      FIXTURE_ROLES.map((role) => ({
        id: role.id,
        siteId: SITE,
        systemKey: role.systemKey,
        name: role.name,
        adminAccess: role.adminAccess,
        appAccess: role.appAccess,
      })),
    );
  }

  async function legacyPoliciesInSite() {
    return db
      .select({
        id: policies.id,
        key: policies.key,
        adminAccess: policies.adminAccess,
        appAccess: policies.appAccess,
        enforceTfa: policies.enforceTfa,
        ipAllow: policies.ipAllow,
        ipDeny: policies.ipDeny,
        validFrom: policies.validFrom,
        validUntil: policies.validUntil,
      })
      .from(policies)
      .where(like(policies.key, `${LEGACY_POLICY_KEY_PREFIX}%`));
  }

  it('backfills, passes the documented post-check, is idempotent, and rolls back', async () => {
    if (!canConnect) {
      console.warn('Skipping upgrade-path E2E: no database connection.');
      return;
    }

    // ── 0. The legacy instance genuinely fails the post-check before backfill ─
    const before = await findUnbackfilledRoles(db);
    const fixtureIds = new Set<string>(FIXTURE_ROLES.filter((r) => r.adminAccess || r.appAccess).map((r) => r.id));
    expect(before.filter((r) => fixtureIds.has(r.id))).toHaveLength(3);

    // ── 1. Run the real backfill ─────────────────────────────────────────────
    const first = await backfillRolePolicyFlags(db);
    // At least our 3 legacy-flag roles; other suites' fixtures may add more.
    expect(first.legacyRoleCount).toBeGreaterThanOrEqual(3);

    // ── 2. Documented post-check returns zero rows (whole database) ──────────
    expect(await findUnbackfilledRoles(db)).toHaveLength(0);

    // ── 3. Exact flag preservation per role shape ────────────────────────────
    const legacy = await legacyPoliciesInSite();
    const byKey = new Map(legacy.map((p) => [p.key, p]));

    const admin = byKey.get(`${LEGACY_POLICY_KEY_PREFIX}upg_administrator`);
    expect(admin).toMatchObject({ adminAccess: true, appAccess: true });

    const appOnly = byKey.get(`${LEGACY_POLICY_KEY_PREFIX}upg_app_only`);
    expect(appOnly).toMatchObject({ adminAccess: false, appAccess: true });

    const apiAdmin = byKey.get(`${LEGACY_POLICY_KEY_PREFIX}upg_api_admin`);
    expect(apiAdmin).toMatchObject({ adminAccess: true, appAccess: false });

    // Flag-only contract: no TFA, no IP guards, no time window.
    for (const policy of [admin, appOnly, apiAdmin]) {
      expect(policy).toMatchObject({ enforceTfa: false, ipAllow: [], ipDeny: [], validFrom: null, validUntil: null });
    }

    // The no-flags role gets no policy and no link.
    expect(byKey.has(`${LEGACY_POLICY_KEY_PREFIX}upg_no_access`)).toBe(false);
    const noneLinks = await db.select().from(rolePolicies).where(eq(rolePolicies.roleId, 'upg_role_none'));
    expect(noneLinks).toHaveLength(0);

    // Each backfilled role is linked to exactly its legacy policy.
    for (const role of FIXTURE_ROLES.filter((r) => r.adminAccess || r.appAccess)) {
      const links = await db.select().from(rolePolicies).where(eq(rolePolicies.roleId, role.id));
      expect(links, `${role.id} has exactly one legacy link`).toHaveLength(1);
    }

    // ── 4. Idempotency: re-run converges without duplicates ─────────────────
    const second = await backfillRolePolicyFlags(db);
    expect(second.linksInserted).toBe(0);
    const legacyAfterRerun = await legacyPoliciesInSite();
    expect(legacyAfterRerun).toHaveLength(legacy.length);
    expect(await findUnbackfilledRoles(db)).toHaveLength(0);

    // ── 5. Role flags were never mutated (rollback anchor) ──────────────────
    const flagRows = await db
      .select({ id: roles.id, adminAccess: roles.adminAccess, appAccess: roles.appAccess })
      .from(roles)
      .where(eq(roles.siteId, SITE));
    for (const fixture of FIXTURE_ROLES) {
      const row = flagRows.find((r) => r.id === fixture.id);
      expect(row, `${fixture.id} still exists`).toBeTruthy();
      expect(row).toMatchObject({ adminAccess: fixture.adminAccess, appAccess: fixture.appAccess });
    }

    // ── 6. Compat-window rollback removes the backfill cleanly ──────────────
    const { policiesDeleted } = await rollbackRolePolicyBackfill(db);
    expect(policiesDeleted).toBeGreaterThanOrEqual(3);
    expect(await legacyPoliciesInSite()).toHaveLength(0);
    // Role flags intact → legacy fallback still grants access after rollback.
    const afterRollback = await findUnbackfilledRoles(db);
    expect(afterRollback.filter((r) => fixtureIds.has(r.id))).toHaveLength(3);
  });
});
