import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql, TransactionRollbackError, type SQL } from 'drizzle-orm';
import type { Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * `packages/database/migrations/rls-policies.sql` against a real Postgres, as a
 * NOSUPERUSER NOBYPASSRLS role (B125).
 *
 * ## Why this exists
 *
 * Every `site_isolation` policy in that file used to be RESTRICTIVE and the file
 * created no PERMISSIVE policy. Postgres shows a role without BYPASSRLS no rows
 * unless at least one permissive policy passes, so the app role the file asks
 * for saw 0 rows and wrote 0 rows on every listed table — the backstop looked
 * right and never allowed anything. Superusers bypass RLS, which is why every
 * other DB suite (they connect as the CI superuser) could not notice.
 *
 * The file now creates a pair per table: `site_isolation` (RESTRICTIVE) and
 * `site_isolation_permit` (PERMISSIVE), both `site_id = app_site_id()`.
 *
 * ## How it runs
 *
 * CI's `db-integration` job migrates the database first (`pnpm --filter
 * @lumibase/database migrate`); this suite then applies the RLS file itself.
 * Every case runs inside ONE transaction that is rolled back: the role, grants,
 * policies, function, `ALTER DATABASE` default and seed rows all disappear, so
 * the suites that share this database never see RLS turned on.
 *
 * The table list is parsed from the SQL file, so a table added to the file
 * later is covered without editing this test.
 */

const RLS_SQL = readFileSync(
  resolve(__dirname, '..', '..', '..', '..', 'packages/database/migrations/rls-policies.sql'),
  'utf8',
);

function parseTables(source: string): string[] {
  const block = /tables text\[\] := ARRAY\[([\s\S]*?)\];/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'(lumibase_[a-z_]+)'/g)].map((m) => m[1]!);
}

const TABLES = parseTables(RLS_SQL);
const NULLABLE_SITE_TABLE = 'lumibase_extensions';

/**
 * The shape of the file before B125: definer-rights helper without a pinned
 * search_path and ONLY restrictive policies. Used to reproduce the bug and to
 * prove the new file converges from it. It also drops `site_isolation_permit`
 * so the reproduction holds on a database where the new file was applied by
 * hand earlier; the old file never created that name, so this changes nothing
 * for a real pre-B125 database.
 */
const LEGACY_SQL = `
CREATE OR REPLACE FUNCTION app_site_id() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT NULLIF(current_setting('app.site_id', true), '');
  $$;
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[${TABLES.map((t) => `'${t}'`).join(', ')}];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS site_isolation ON %I', tbl);
    EXECUTE format('DROP POLICY IF EXISTS site_isolation_permit ON %I', tbl);
    EXECUTE format($pol$
      CREATE POLICY site_isolation ON %I
        AS RESTRICTIVE
        USING (site_id = app_site_id())
        WITH CHECK (site_id = app_site_id())
    $pol$, tbl);
  END LOOP;
END $$;
DROP POLICY IF EXISTS site_isolation ON lumibase_extensions;
CREATE POLICY site_isolation ON lumibase_extensions
  AS RESTRICTIVE
  USING (site_id IS NULL OR site_id = app_site_id())
  WITH CHECK (site_id IS NULL OR site_id = app_site_id());
ALTER TABLE lumibase_role_policies DISABLE ROW LEVEL SECURITY;
`;

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

async function query<T>(tx: Tx, statement: SQL): Promise<T[]> {
  return rowsOf<T>(await tx.execute(statement));
}

async function ids(tx: Tx, table: string): Promise<string[]> {
  const rows = await query<{ id: string }>(tx, sql`SELECT id FROM ${sql.identifier(table)}`);
  // Sorted in JS so the comparison does not depend on the database collation.
  return rows.map((r) => r.id).sort();
}

async function count(tx: Tx, table: string): Promise<number> {
  const [row] = await query<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`);
  return row!.n;
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

/** Run `statement` in a savepoint and assert Postgres rejects it with RLS's 42501. */
async function expectRlsViolation(tx: Tx, statement: SQL): Promise<void> {
  let caught: unknown;
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(statement);
    });
  } catch (error) {
    caught = error;
  }
  expect(caught, 'statement was expected to violate row-level security').toBeDefined();
  expect(pgCode(caught)).toBe('42501');
}

// Lowercase hex only: the value ends up in a role name and in row ids.
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

interface Fixture {
  role: string;
  siteA: string;
  siteB: string;
  settingsA: string[];
  settingsB: string[];
  runsA: string[];
  runsB: string[];
  runAOld: string;
  runBOld: string;
  extGlobal: string;
  extA: string;
  extB: string;
}

describe.skipIf(!hasDbIntegrationUrl)('rls-policies.sql — DB integration (B125)', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('rls-policies');
    const [me] = rowsOf<{ rolsuper: boolean }>(
      await db.execute(sql`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`),
    );
    if (!me?.rolsuper) {
      throw new Error(
        'rls-policies suite needs a superuser DATABASE_URL (CREATE ROLE, ALTER DATABASE, CREATE POLICY). ' +
          'CI uses the postgres image superuser.',
      );
    }
    const missing = rowsOf<{ t: string }>(
      await db.execute(
        sql`SELECT t FROM unnest(${`{${TABLES.join(',')}}`}::text[]) AS t WHERE to_regclass(t) IS NULL`,
      ),
    ).map((r) => r.t);
    if (missing.length > 0) {
      throw new Error(`run the schema migration first; tables missing: ${missing.join(', ')}`);
    }
  });

  /** One rolled-back transaction per case: nothing here outlives the case. */
  async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        await fn(tx);
        tx.rollback();
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    }
  }

  /** Create the app role and seed two sites, as the superuser (RLS bypassed). */
  async function seed(tx: Tx): Promise<Fixture> {
    const s = rand();
    const role = `b125_rls_${s}`;
    const f: Fixture = {
      role,
      siteA: `rls_a_${s}`,
      siteB: `rls_b_${s}`,
      settingsA: [`set_a1_${s}`, `set_a2_${s}`],
      settingsB: [`set_b1_${s}`, `set_b2_${s}`],
      runAOld: `run_a_old_${s}`,
      runBOld: `run_b_old_${s}`,
      runsA: [`run_a_new_${s}`, `run_a_old_${s}`],
      runsB: [`run_b_old_${s}`],
      extGlobal: `ext_g_${s}`,
      extA: `ext_a_${s}`,
      extB: `ext_b_${s}`,
    };
    const r = sql.identifier(role);
    await tx.execute(sql`CREATE ROLE ${r} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
    await tx.execute(sql`GRANT USAGE ON SCHEMA public TO ${r}`);
    await tx.execute(sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r}`);

    await tx.execute(sql`INSERT INTO lumibase_sites (id, name) VALUES (${f.siteA}, 'A'), (${f.siteB}, 'B')`);
    await tx.execute(sql`
      INSERT INTO lumibase_settings (id, site_id, key, value) VALUES
        (${f.settingsA[0]}, ${f.siteA}, 'k1', '{}'), (${f.settingsA[1]}, ${f.siteA}, 'k2', '{}'),
        (${f.settingsB[0]}, ${f.siteB}, 'k1', '{}'), (${f.settingsB[1]}, ${f.siteB}, 'k2', '{}')`);
    await tx.execute(sql`
      INSERT INTO lumibase_review_profiles (id, site_id, collection, key, version, status, fields, questions, created_by)
      VALUES (${`rp_a_${s}`}, ${f.siteA}, 'posts', 'spam', 1, 'active', '["title"]', '{}', 'u'),
             (${`rp_b_${s}`}, ${f.siteB}, 'posts', 'spam', 1, 'active', '["title"]', '{}', 'u')`);
    await tx.execute(sql`
      INSERT INTO lumibase_review_runs (id, site_id, profile_id, profile_key, profile_version, collection,
        content_hash, source, omitted_fields, principal_type, principal_id, status, idempotency_key, created_at)
      VALUES
        (${f.runAOld}, ${f.siteA}, ${`rp_a_${s}`}, 'spam', 1, 'posts', 'h', 'item', '[]', 'user', 'u', 'success', 'k1', now() - interval '400 days'),
        (${`run_a_new_${s}`}, ${f.siteA}, ${`rp_a_${s}`}, 'spam', 1, 'posts', 'h', 'item', '[]', 'user', 'u', 'success', 'k2', now()),
        (${f.runBOld}, ${f.siteB}, ${`rp_b_${s}`}, 'spam', 1, 'posts', 'h', 'item', '[]', 'user', 'u', 'success', 'k3', now() - interval '400 days')`);
    await tx.execute(sql`
      INSERT INTO lumibase_extensions (id, site_id, name, version, type, bundle_url) VALUES
        (${f.extGlobal}, NULL, 'g', '1.0.0', 'interface', 'https://example.test/g.js'),
        (${f.extA}, ${f.siteA}, 'a', '1.0.0', 'interface', 'https://example.test/a.js'),
        (${f.extB}, ${f.siteB}, 'b', '1.0.0', 'interface', 'https://example.test/b.js')`);
    return f;
  }

  const applyRls = (tx: Tx) => tx.execute(sql.raw(RLS_SQL));
  const applyLegacy = (tx: Tx) => tx.execute(sql.raw(LEGACY_SQL));

  /** Switch to the app role (once) and set the tenant scope for this transaction. */
  async function asApp(tx: Tx, f: Fixture, siteId: string | null): Promise<void> {
    await tx.execute(sql`SET LOCAL ROLE ${sql.identifier(f.role)}`);
    await tx.execute(sql`SELECT set_config('app.site_id', ${siteId ?? ''}, true)`);
  }

  const asSuperuser = (tx: Tx) => tx.execute(sql`RESET ROLE`);

  it('parses the table list from the SQL file, so the cases below cannot pass vacuously', () => {
    expect(TABLES.length).toBeGreaterThanOrEqual(48);
    expect(new Set(TABLES).size).toBe(TABLES.length);
    for (const t of ['lumibase_review_runs', 'lumibase_settings', NULLABLE_SITE_TABLE, 'lumibase_ai_automation_actions']) {
      expect(TABLES).toContain(t);
    }
  });

  it('reproduces B125 on the restrictive-only file, then the new file converges from it', async () => {
    await inRolledBackTx(async (tx) => {
      await applyLegacy(tx);
      const f = await seed(tx);

      // Baseline: the old file hides the app role's own rows. If this ever
      // stops being 0 the test no longer sees the bug it was written for.
      await asApp(tx, f, f.siteA);
      expect(await count(tx, 'lumibase_review_runs')).toBe(0);
      expect(await count(tx, 'lumibase_settings')).toBe(0);

      await asSuperuser(tx);
      await applyRls(tx);

      await asApp(tx, f, f.siteA);
      expect(await ids(tx, 'lumibase_review_runs')).toEqual([...f.runsA].sort());
      expect(await ids(tx, 'lumibase_settings')).toEqual([...f.settingsA].sort());
    });
  });

  it('TRIPWIRE: no table in the file is left with only restrictive policies', async () => {
    await inRolledBackTx(async (tx) => {
      // Over the old file, so the check also covers the upgrade path.
      await applyLegacy(tx);
      await applyRls(tx);

      // A table whose policies are all restrictive (or that has none while
      // RLS is on) shows a non-BYPASSRLS role nothing — B125. Grouped per
      // table and independent of policy names, so a renamed or extra policy
      // cannot hide a table that lost its permissive half.
      const restrictiveOnly = await query<{ tablename: string }>(
        tx,
        sql`SELECT c.relname AS tablename FROM pg_class c
              LEFT JOIN pg_policy p ON p.polrelid = c.oid
             WHERE c.relnamespace = 'public'::regnamespace
               AND c.relname = ANY(${`{${TABLES.join(',')}}`}::text[])
             GROUP BY c.relname
            HAVING NOT coalesce(bool_or(p.polpermissive), false)`,
      );
      expect(restrictiveOnly.map((r) => r.tablename)).toEqual([]);
    });
  });

  it('leaves exactly the policy pair on every table, applied twice (idempotent)', async () => {
    await inRolledBackTx(async (tx) => {
      await applyRls(tx);
      await applyRls(tx);

      const flags = await query<{ relname: string; rls: boolean; force: boolean }>(
        tx,
        sql`SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
             WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
               AND relname = ANY(${`{${[...TABLES, 'lumibase_role_policies'].join(',')}}`}::text[])`,
      );
      const byName = new Map(flags.map((r) => [r.relname, r]));
      for (const t of TABLES) {
        expect(byName.get(t), t).toMatchObject({ rls: true, force: true });
      }
      expect(byName.get('lumibase_role_policies')?.rls).toBe(false);

      const policies = await query<{
        tablename: string;
        policyname: string;
        permissive: string;
        cmd: string;
        roles: string;
        qual: string;
        with_check: string;
      }>(
        tx,
        sql`SELECT tablename, policyname, permissive, cmd, roles::text AS roles, qual, with_check
              FROM pg_policies WHERE schemaname = 'public'
               AND tablename = ANY(${`{${TABLES.join(',')}}`}::text[])
             ORDER BY tablename, policyname`,
      );
      const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
      for (const t of TABLES) {
        const predicate =
          t === NULLABLE_SITE_TABLE ? '((site_id IS NULL) OR (site_id = app_site_id()))' : '(site_id = app_site_id())';
        const mine = policies
          .filter((p) => p.tablename === t)
          .map((p) => ({
            policyname: p.policyname,
            permissive: p.permissive,
            cmd: p.cmd,
            roles: p.roles,
            qual: norm(p.qual),
            with_check: norm(p.with_check),
          }));
        expect(mine, t).toEqual([
          { policyname: 'site_isolation', permissive: 'RESTRICTIVE', cmd: 'ALL', roles: '{public}', qual: predicate, with_check: predicate },
          { policyname: 'site_isolation_permit', permissive: 'PERMISSIVE', cmd: 'ALL', roles: '{public}', qual: predicate, with_check: predicate },
        ]);
      }

      const [fn] = await query<{ prosecdef: boolean; config: string }>(
        tx,
        sql`SELECT prosecdef, array_to_string(proconfig, ',') AS config FROM pg_proc
             WHERE proname = 'app_site_id' AND pronamespace = 'public'::regnamespace`,
      );
      expect(fn?.prosecdef).toBe(false);
      expect(fn?.config).toContain('search_path=pg_catalog, pg_temp');

      // Informational (B127): site-scoped tables the file does not cover yet.
      const uncovered = await query<{ table_name: string }>(
        tx,
        sql`SELECT DISTINCT table_name FROM information_schema.columns
             WHERE table_schema = 'public' AND column_name = 'site_id' AND table_name LIKE 'lumibase\\_%'
               AND NOT (table_name = ANY(${`{${TABLES.join(',')}}`}::text[]))
             ORDER BY table_name`,
      );
      console.info(`[B127] site_id tables without RLS (${uncovered.length}): ${uncovered.map((r) => r.table_name).join(', ')}`);
    });
  });

  it('shows the app role exactly its own site and nothing of the other', async () => {
    await inRolledBackTx(async (tx) => {
      await applyRls(tx);
      const f = await seed(tx);

      await asApp(tx, f, f.siteA);
      expect(await ids(tx, 'lumibase_settings')).toEqual([...f.settingsA].sort());
      expect(await ids(tx, 'lumibase_review_runs')).toEqual([...f.runsA].sort());

      await asApp(tx, f, f.siteB);
      expect(await ids(tx, 'lumibase_settings')).toEqual([...f.settingsB].sort());
      expect(await ids(tx, 'lumibase_review_runs')).toEqual([...f.runsB].sort());
    });
  });

  it('shows zero rows — never every row — when app.site_id is unset, empty or unknown', async () => {
    await inRolledBackTx(async (tx) => {
      await applyRls(tx);
      const f = await seed(tx);
      await asApp(tx, f, f.siteA);

      const scopes: Array<[string, SQL, boolean]> = [
        ['empty', sql`SELECT set_config('app.site_id', '', true)`, true],
        ['reset', sql`RESET app.site_id`, true],
        ['unknown site', sql`SELECT set_config('app.site_id', 'site_does_not_exist', true)`, false],
      ];
      for (const [label, statement, isNull] of scopes) {
        await tx.execute(statement);
        if (isNull) {
          const [row] = await query<{ v: string | null }>(tx, sql`SELECT app_site_id() AS v`);
          expect(row?.v, label).toBeNull();
        }
        expect(await count(tx, 'lumibase_settings'), label).toBe(0);
        expect(await count(tx, 'lumibase_review_runs'), label).toBe(0);
      }
    });
  });

  it('scopes writes: deletes only own rows, refuses INSERT/UPDATE into another site', async () => {
    await inRolledBackTx(async (tx) => {
      await applyRls(tx);
      const f = await seed(tx);

      // (a) No scope: the unscoped purge (pre-B114 shape) deletes nothing.
      await asApp(tx, f, null);
      const unscoped = await query<{ id: string }>(
        tx,
        sql`DELETE FROM lumibase_review_runs WHERE created_at < now() - interval '180 days' RETURNING id`,
      );
      expect(unscoped).toEqual([]);

      // (b) Scope A: the SAME statement, no site filter, deletes only A's old run.
      await asApp(tx, f, f.siteA);
      const scoped = await query<{ id: string }>(
        tx,
        sql`DELETE FROM lumibase_review_runs WHERE created_at < now() - interval '180 days' RETURNING id`,
      );
      expect(scoped.map((r) => r.id)).toEqual([f.runAOld]);

      // (c) UPDATE aimed at B's rows touches nothing.
      const crossUpdate = await query<{ id: string }>(
        tx,
        sql`UPDATE lumibase_settings SET value = '{"x":1}' WHERE site_id = ${f.siteB} RETURNING id`,
      );
      expect(crossUpdate).toEqual([]);

      // (d) Moving an own row into B fails WITH CHECK.
      await expectRlsViolation(tx, sql`UPDATE lumibase_settings SET site_id = ${f.siteB} WHERE id = ${f.settingsA[0]}`);

      // (e) INSERT into B fails WITH CHECK.
      await expectRlsViolation(
        tx,
        sql`INSERT INTO lumibase_settings (id, site_id, key, value) VALUES (${`set_x_${rand()}`}, ${f.siteB}, 'k9', '{}')`,
      );

      // (f) INSERT into own site works.
      const own = await query<{ id: string }>(
        tx,
        sql`INSERT INTO lumibase_settings (id, site_id, key, value) VALUES (${`set_y_${rand()}`}, ${f.siteA}, 'k9', '{}') RETURNING id`,
      );
      expect(own).toHaveLength(1);

      // (g) No scope: even an INSERT into A fails WITH CHECK.
      await tx.execute(sql`SELECT set_config('app.site_id', '', true)`);
      await expectRlsViolation(
        tx,
        sql`INSERT INTO lumibase_settings (id, site_id, key, value) VALUES (${`set_z_${rand()}`}, ${f.siteA}, 'k8', '{}')`,
      );

      // (h) B is untouched.
      await asSuperuser(tx);
      const [b] = await query<{ settings: number; runs: number }>(
        tx,
        sql`SELECT (SELECT count(*)::int FROM lumibase_settings WHERE site_id = ${f.siteB} AND value = '{}') AS settings,
                   (SELECT count(*)::int FROM lumibase_review_runs WHERE id = ${f.runBOld}) AS runs`,
      );
      expect(b).toEqual({ settings: 2, runs: 1 });
    });
  });

  it('keeps global extensions visible and site extensions scoped', async () => {
    await inRolledBackTx(async (tx) => {
      await applyRls(tx);
      const f = await seed(tx);

      await asApp(tx, f, f.siteA);
      const seenA = await ids(tx, NULLABLE_SITE_TABLE);
      expect(seenA).toEqual(expect.arrayContaining([f.extGlobal, f.extA]));
      expect(seenA).not.toContain(f.extB);

      await asApp(tx, f, null);
      const seenUnscoped = await ids(tx, NULLABLE_SITE_TABLE);
      expect(seenUnscoped).toContain(f.extGlobal);
      expect(seenUnscoped).not.toContain(f.extA);
      expect(seenUnscoped).not.toContain(f.extB);

      await asApp(tx, f, f.siteA);
      await expectRlsViolation(
        tx,
        sql`INSERT INTO lumibase_extensions (id, site_id, name, version, type, bundle_url)
            VALUES (${`ext_x_${rand()}`}, ${f.siteB}, 'x', '1.0.0', 'interface', 'https://example.test/x.js')`,
      );
      const global = await query<{ id: string }>(
        tx,
        sql`INSERT INTO lumibase_extensions (id, site_id, name, version, type, bundle_url)
            VALUES (${`ext_y_${rand()}`}, NULL, 'y', '1.0.0', 'interface', 'https://example.test/y.js') RETURNING id`,
      );
      expect(global).toHaveLength(1);
    });
  });

  it('stays isolated when an operator adds a USING (true) permissive policy (the B125 workaround)', async () => {
    await inRolledBackTx(async (tx) => {
      await applyRls(tx);
      const f = await seed(tx);
      await tx.execute(sql`CREATE POLICY b125_workaround ON lumibase_settings AS PERMISSIVE USING (true) WITH CHECK (true)`);

      await asApp(tx, f, f.siteA);
      expect(await ids(tx, 'lumibase_settings')).toEqual([...f.settingsA].sort());
      await expectRlsViolation(
        tx,
        sql`INSERT INTO lumibase_settings (id, site_id, key, value) VALUES (${`set_w_${rand()}`}, ${f.siteB}, 'k7', '{}')`,
      );
      await tx.execute(sql`SELECT set_config('app.site_id', '', true)`);
      expect(await count(tx, 'lumibase_settings')).toBe(0);
    });
  });

  it('still fails closed when site_isolation is dropped', async () => {
    await inRolledBackTx(async (tx) => {
      await applyRls(tx);
      const f = await seed(tx);
      await tx.execute(sql`DROP POLICY site_isolation ON lumibase_settings`);

      await asApp(tx, f, f.siteA);
      expect(await ids(tx, 'lumibase_settings')).toEqual([...f.settingsA].sort());
      await tx.execute(sql`SELECT set_config('app.site_id', '', true)`);
      expect(await count(tx, 'lumibase_settings')).toBe(0);
    });
  });
});
