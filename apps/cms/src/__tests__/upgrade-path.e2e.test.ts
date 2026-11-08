import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import {
  LEGACY_POLICY_KEY_PREFIX,
  backfillRolePolicyFlags,
  createDb,
  deriveLegacyRoleKey,
  detectHistoryMismatch,
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
  // Collision pair: two roles whose keys normalize to the SAME readable string
  // (`upg_collide`) but carry DIFFERENT flags. A key derived from the readable
  // part alone would map both onto one policy and leak admin to the non-admin
  // role; the backfill must give each its own policy (regression for the
  // legacy-key-collision privilege-escalation finding).
  // collide_plain must carry a flag (app-only) so the backfill processes it —
  // that is exactly the condition under which a shared policy would leak admin.
  { id: 'upg_role_collide_admin', name: 'Upg Collide A', systemKey: 'upg-collide', adminAccess: true, appAccess: true },
  { id: 'upg_role_collide_plain', name: 'Upg Collide B', systemKey: 'Upg Collide', adminAccess: false, appAccess: true },
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

    // Expected collision-proof policy key for a fixture role (readable part +
    // stable role id), mirroring `deriveLegacyRoleKey`.
    const expectedKey = (id: string): string => {
      const f = FIXTURE_ROLES.find((r) => r.id === id)!;
      return `${LEGACY_POLICY_KEY_PREFIX}${deriveLegacyRoleKey({ id: f.id, key: null, systemKey: f.systemKey })}`;
    };

    // The five flag-carrying fixture roles (everything except `none`).
    const flaggedIds = FIXTURE_ROLES.filter((r) => r.adminAccess || r.appAccess).map((r) => r.id);

    // ── 0. The legacy instance genuinely fails the post-check before backfill ─
    const before = await findUnbackfilledRoles(db);
    const fixtureIds = new Set<string>(flaggedIds);
    expect(before.filter((r) => fixtureIds.has(r.id))).toHaveLength(flaggedIds.length);

    // ── 1. Run the real backfill ─────────────────────────────────────────────
    const first = await backfillRolePolicyFlags(db);
    // At least our flag-carrying roles; other suites' fixtures may add more.
    expect(first.legacyRoleCount).toBeGreaterThanOrEqual(flaggedIds.length);

    // ── 2. Documented post-check returns zero rows (whole database) ──────────
    expect(await findUnbackfilledRoles(db)).toHaveLength(0);

    // ── 3. Exact flag preservation per role shape ────────────────────────────
    const legacy = await legacyPoliciesInSite();
    const byKey = new Map(legacy.map((p) => [p.key, p]));

    const admin = byKey.get(expectedKey('upg_role_admin'));
    expect(admin).toMatchObject({ adminAccess: true, appAccess: true });

    const appOnly = byKey.get(expectedKey('upg_role_app'));
    expect(appOnly).toMatchObject({ adminAccess: false, appAccess: true });

    const apiAdmin = byKey.get(expectedKey('upg_role_api'));
    expect(apiAdmin).toMatchObject({ adminAccess: true, appAccess: false });

    // Flag-only contract: no TFA, no IP guards, no time window.
    for (const policy of [admin, appOnly, apiAdmin]) {
      expect(policy).toMatchObject({ enforceTfa: false, ipAllow: [], ipDeny: [], validFrom: null, validUntil: null });
    }

    // ── 3b. Colliding role keys get SEPARATE policies — no admin leak ────────
    // Both roles' keys normalize to `upg_collide`; the id suffix keeps them
    // distinct so the app-only role never inherits the admin role's flags.
    const collideAdmin = byKey.get(expectedKey('upg_role_collide_admin'));
    const collidePlain = byKey.get(expectedKey('upg_role_collide_plain'));
    expect(collideAdmin, 'collide-admin has its own policy').toBeTruthy();
    expect(collidePlain, 'collide-plain has its own policy').toBeTruthy();
    expect(collideAdmin!.id).not.toBe(collidePlain!.id);
    expect(collideAdmin).toMatchObject({ adminAccess: true });
    // The critical assertion: the app-only role did NOT pick up admin_access.
    expect(collidePlain).toMatchObject({ adminAccess: false, appAccess: true });

    // The no-flags role gets no policy and no link.
    expect(byKey.has(expectedKey('upg_role_none'))).toBe(false);
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
    expect(policiesDeleted).toBeGreaterThanOrEqual(flaggedIds.length);
    expect(await legacyPoliciesInSite()).toHaveLength(0);
    // Role flags intact → legacy fallback still grants access after rollback.
    const afterRollback = await findUnbackfilledRoles(db);
    expect(afterRollback.filter((r) => fixtureIds.has(r.id))).toHaveLength(flaggedIds.length);
  });
});

const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../../../packages/database/drizzle');
const UPGRADE_DB_NAME = 'lumibase_upgrade_0x_e2e';

function withDatabaseName(connectionString: string, dbName: string): string {
  const parsed = new URL(connectionString);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

describe('Real 0.18.0 (0000_lumibase_init) → 1.0 (0023) schema + data migration', () => {
  let adminClient: ReturnType<typeof postgres> | null = null;
  let upgClient: ReturnType<typeof postgres> | null = null;
  let upgDb: Database | null = null;
  let canConnect = false;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) {
      return;
    }
    try {
      adminClient = postgres(TEST_DATABASE_URL, { max: 1 });
      await adminClient`SELECT 1`;
      canConnect = true;
    } catch {
      canConnect = false;
      if (adminClient) {
        await adminClient.end().catch(() => undefined);
        adminClient = null;
      }
      return;
    }

    await adminClient.unsafe(`DROP DATABASE IF EXISTS "${UPGRADE_DB_NAME}" WITH (FORCE)`);
    await adminClient.unsafe(`CREATE DATABASE "${UPGRADE_DB_NAME}"`);

    const upgUrl = withDatabaseName(TEST_DATABASE_URL, UPGRADE_DB_NAME);
    upgClient = postgres(upgUrl, { max: 1 });
    upgDb = createDb(upgUrl);
  }, 60_000);

  afterAll(async () => {
    if (upgClient) {
      await upgClient.end().catch(() => undefined);
    }
    // Close the pooled client inside `upgDb` before dropping the database.
    if (upgDb) {
      const internalClient = (upgDb as unknown as { $client?: { end?: () => Promise<void> } }).$client;
      await internalClient?.end?.().catch(() => undefined);
    }
    if (adminClient && canConnect) {
      await adminClient.unsafe(`DROP DATABASE IF EXISTS "${UPGRADE_DB_NAME}" WITH (FORCE)`).catch(() => undefined);
      await adminClient.end().catch(() => undefined);
    }
  }, 30_000);

  it('installs 0000_lumibase_init (v0.18.0), seeds 0.x data, runs 0017 preflight, applies 0001..0023, and backfills RBAC', async () => {
    if (!canConnect || !upgClient || !upgDb) {
      console.warn('Skipping real 0.18.0 → 1.0 migration E2E: no database connection.');
      return;
    }

    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const initEntry = journal.entries[0]!;
    expect(initEntry.tag).toBe('0000_lumibase_init');

    const initSql = fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${initEntry.tag}.sql`), 'utf8');
    const initHash = crypto.createHash('sha256').update(initSql).digest('hex');

    // ── 1. Bootstrap a genuine v0.18.0 (0000_lumibase_init) database ─────────
    for (const stmt of initSql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed) {
        await upgClient.unsafe(trimmed);
      }
    }
    await upgClient.unsafe(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await upgClient.unsafe(`
      CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    await upgClient`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${initHash}, ${initEntry.when})
    `;

    // Confirm post-0000 tables and columns do NOT exist yet.
    const [preCheck] = await upgClient<
      Array<{
        domains_table: string | null;
        reviews_table: string | null;
        token_version_col: number;
        api_key_owner_col: number;
      }>
    >`
      SELECT
        to_regclass('public.lumibase_site_domains')::text AS domains_table,
        to_regclass('public.lumibase_review_profiles')::text AS reviews_table,
        (SELECT count(*)::int FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'lumibase_users' AND column_name = 'token_version') AS token_version_col,
        (SELECT count(*)::int FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'lumibase_ai_conversations' AND column_name = 'api_key_id') AS api_key_owner_col
    `;
    expect(preCheck).toEqual({
      domains_table: null,
      reviews_table: null,
      token_version_col: 0,
      api_key_owner_col: 0,
    });

    // ── 2. Seed representative 0.x data onto the 0000 schema ─────────────────
    const siteId = 'site_018_real';
    await upgClient`
      INSERT INTO lumibase_sites (id, name, domain)
      VALUES (${siteId}, 'Real 0.18 Instance', 'legacy.example.com')
    `;
    await upgClient`
      INSERT INTO lumibase_roles (id, site_id, system_key, name, admin_access, app_access)
      VALUES
        ('r018_admin', ${siteId}, 'administrator', 'Administrator', true, true),
        ('r018_editor', ${siteId}, 'editor-team', 'Editor A', false, true),
        ('r018_editor_dup', ${siteId}, 'Editor Team', 'Editor B', true, false)
    `;
    await upgClient`
      INSERT INTO lumibase_users (id, email, first_name, status, is_bootstrap)
      VALUES ('u018_1', 'admin@legacy.example.com', 'Legacy Admin', 'active', true)
    `;
    await upgClient`
      INSERT INTO lumibase_user_sites (user_id, site_id, role_id)
      VALUES ('u018_1', ${siteId}, 'r018_admin')
    `;
    await upgClient`
      INSERT INTO lumibase_collections (id, site_id, name)
      VALUES ('c018_posts', ${siteId}, 'posts')
    `;
    await upgClient`
      INSERT INTO lumibase_fields (id, site_id, collection_id, name, type, interface)
      VALUES ('f018_title', ${siteId}, 'c018_posts', 'title', 'string', 'input')
    `;
    await upgClient`
      INSERT INTO lumibase_items (id, site_id, collection_id, status, data)
      VALUES ('itm018_1', ${siteId}, 'c018_posts', 'published', '{"title":"Hello from 0.18"}'::jsonb)
    `;
    await upgClient`
      INSERT INTO lumibase_revisions (id, site_id, collection_id, item_id, delta)
      VALUES ('01900000-0000-7000-8000-000000000001', ${siteId}, 'c018_posts', 'itm018_1', '{"title":"Hello from 0.18"}'::jsonb)
    `;
    await upgClient`
      INSERT INTO lumibase_flows (id, site_id, name, status, trigger_type)
      VALUES ('flw018_1', ${siteId}, 'Legacy Flow', 'active', 'manual')
    `;
    const legacyStartedAt = new Date('2026-07-06T12:00:00.000Z');
    await upgClient`
      INSERT INTO lumibase_flow_runs (id, site_id, flow_id, status, started_at)
      VALUES ('frun018_1', ${siteId}, 'flw018_1', 'completed', ${legacyStartedAt})
    `;
    await upgClient`
      INSERT INTO lumibase_ai_conversations (id, site_id, title)
      VALUES ('conv018_anon', ${siteId}, 'Pre-0023 API-key chat')
    `;

    // Seed an agent goal with TWO active (`running`) runs to verify the
    // documented migration 0017 preflight + settlement in upgrades.md.
    await upgClient`
      INSERT INTO lumibase_agent_goals (id, site_id, title, status, created_by)
      VALUES ('goal018_1', ${siteId}, 'Legacy goal', 'running', 'u018_1')
    `;
    await upgClient`
      INSERT INTO lumibase_agent_runs (id, site_id, goal_id, agent_name, status)
      VALUES
        ('arun018_old', ${siteId}, 'goal018_1', 'Writer', 'running'),
        ('arun018_new', ${siteId}, 'goal018_1', 'Writer', 'running')
    `;

    // ── 3. Execute documented 0017 preflight & settlement before migrating ───
    const dupGoals = await upgClient<Array<{ site_id: string; goal_id: string; count: number }>>`
      SELECT site_id, goal_id, count(*)::int AS count
      FROM lumibase_agent_runs
      WHERE status IN ('queued', 'running')
      GROUP BY site_id, goal_id
      HAVING count(*) > 1
    `;
    expect(dupGoals).toEqual([{ site_id: siteId, goal_id: 'goal018_1', count: 2 }]);

    await upgClient`
      UPDATE lumibase_agent_runs
      SET status = 'cancelled',
          error = 'duplicate in-flight run settled before migration 0017',
          metrics = coalesce(metrics, '{}'::jsonb) || '{"stopReason":"duplicate_dispatch"}'::jsonb,
          finished_at = now(),
          updated_at = now()
      WHERE id = 'arun018_old'
    `;

    const dupAfterSettle = await upgClient`
      SELECT site_id, goal_id
      FROM lumibase_agent_runs
      WHERE status IN ('queued', 'running')
      GROUP BY site_id, goal_id
      HAVING count(*) > 1
    `;
    expect(dupAfterSettle).toHaveLength(0);

    // ── 4. Run Drizzle's real migrator across 0001..0023 ─────────────────────
    await migrate(upgDb, { migrationsFolder: MIGRATIONS_FOLDER });

    const appliedRows = await upgClient<Array<{ id: number; hash: string; created_at: string }>>`
      SELECT id, hash, created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at ASC, id ASC
    `;
    expect(appliedRows).toHaveLength(journal.entries.length);

    const localMeta = journal.entries.map((entry) => ({
      tag: entry.tag,
      hash: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), 'utf8'))
        .digest('hex'),
    }));
    expect(detectHistoryMismatch(localMeta, appliedRows)).toBeNull();

    // ── 5. Verify post-migration schema, constraints, and data preservation ──
    const [postCheck] = await upgClient<
      Array<{
        domains_table: string | null;
        reviews_table: string | null;
        automation_table: string | null;
        token_version: number;
        api_key_id: string | null;
        flow_run_type: string;
        flow_created_at: Date;
        item_title: string;
      }>
    >`
      SELECT
        to_regclass('public.lumibase_site_domains')::text AS domains_table,
        to_regclass('public.lumibase_review_profiles')::text AS reviews_table,
        to_regclass('public.lumibase_ai_automation_actions')::text AS automation_table,
        (SELECT token_version FROM lumibase_users WHERE id = 'u018_1') AS token_version,
        (SELECT api_key_id FROM lumibase_ai_conversations WHERE id = 'conv018_anon') AS api_key_id,
        (SELECT run_type FROM lumibase_flow_runs WHERE id = 'frun018_1') AS flow_run_type,
        (SELECT created_at FROM lumibase_flow_runs WHERE id = 'frun018_1') AS flow_created_at,
        (SELECT data->>'title' FROM lumibase_items WHERE id = 'itm018_1') AS item_title
    `;
    expect(postCheck).toMatchObject({
      domains_table: 'lumibase_site_domains',
      reviews_table: 'lumibase_review_profiles',
      automation_table: 'lumibase_ai_automation_actions',
      token_version: 0,
      api_key_id: null,
      flow_run_type: 'flow',
      item_title: 'Hello from 0.18',
    });
    expect(postCheck!.flow_created_at).toBeInstanceOf(Date);

    // Every public table in the upgraded 0.18 → 1.0 database matches the
    // canonical migrated database.
    const upgTables = await upgClient<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename ASC
    `;
    const mainTables = await adminClient!<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename ASC
    `;
    expect(upgTables.map((t) => t.tablename)).toEqual(mainTables.map((t) => t.tablename));

    // 0012 CHECK constraint rejects elevating the `public` system role.
    await expect(
      upgClient`
        INSERT INTO lumibase_roles (id, site_id, system_key, name, admin_access, app_access)
        VALUES ('r018_bad_public', ${siteId}, 'public', 'Bad Public', true, false)
      `,
    ).rejects.toThrow(/roles_public_least_privilege/);

    // 0013 dropped NOT NULL on flow_id + started_at for async AI chat runs.
    await upgClient`
      INSERT INTO lumibase_flow_runs (id, site_id, flow_id, run_type, status)
      VALUES ('frun018_aichat', ${siteId}, null, 'ai_chat', 'queued')
    `;

    // 0017 unique partial index rejects a second active run on the same goal.
    await expect(
      upgClient`
        INSERT INTO lumibase_agent_runs (id, site_id, goal_id, agent_name, status)
        VALUES ('arun018_dup2', ${siteId}, 'goal018_1', 'Writer', 'queued')
      `,
    ).rejects.toThrow(/agent_runs_one_active_per_goal_idx/);

    // ── 6. Run the RBAC role→policy backfill on the upgraded database ────────
    expect(await findUnbackfilledRoles(upgDb)).toHaveLength(3);
    const backfillResult = await backfillRolePolicyFlags(upgDb);
    expect(backfillResult.legacyRoleCount).toBe(3);
    expect(await findUnbackfilledRoles(upgDb)).toHaveLength(0);
  }, 60_000);
});
