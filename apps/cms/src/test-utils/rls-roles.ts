/**
 * Throwaway database + two roles for request-path RLS tests and the
 * `bench-rls-scope` script (B130, `.kiro/specs/rls-request-scope/` design §7).
 *
 * - creates `lumibase_rls_<rand>` on the server of `adminUrl` (a superuser),
 * - runs every Drizzle migration and applies `rls-policies.sql` as the owner,
 * - creates `rls_app_<rand>` NOSUPERUSER NOBYPASSRLS (the request role) and
 *   `rls_sys_<rand>` NOSUPERUSER BYPASSRLS (the system role), both with DML
 *   grants only.
 *
 * `drop()` removes the database and both roles (roles are cluster-global).
 * Never point `adminUrl` at a server you care about.
 */
import { randomUUID } from 'node:crypto';

const hex = (n: number) => randomUUID().replace(/-/g, '').slice(0, n);
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// `import.meta.url`, not `__dirname`: the bench script runs this as ESM via tsx.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const MIGRATIONS = resolve(REPO, 'packages/database/drizzle');
const RLS_SQL_PATH = resolve(REPO, 'packages/database/migrations/rls-policies.sql');

export interface RlsTestDatabase {
  readonly dbName: string;
  /** Superuser on the new database (seeding, inspection). */
  readonly ownerUrl: string;
  /** NOSUPERUSER NOBYPASSRLS role — what the app connects with under enforce. */
  readonly appUrl: string;
  /** NOSUPERUSER BYPASSRLS role — the system connection. */
  readonly sysUrl: string;
  drop(): Promise<void>;
}

function withDb(url: string, db: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user.name;
    u.password = user.password;
  }
  return u.toString();
}

export async function createRlsTestDatabase(adminUrl: string): Promise<RlsTestDatabase> {
  const suffix = hex(10);
  const dbName = `lumibase_rls_${suffix}`;
  const app = { name: `rls_app_${suffix}`, password: hex(24) };
  const sys = { name: `rls_sys_${suffix}`, password: hex(24) };

  const admin = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const ownerUrl = withDb(adminUrl, dbName);
  const owner = postgres(ownerUrl, { max: 1, prepare: false, onnotice: () => {} });

  const drop = async () => {
    await owner.end({ timeout: 5 }).catch(() => {});
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    for (const role of [app.name, sys.name]) {
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
    await admin.end({ timeout: 5 });
  };

  try {
    await migrate(drizzle(owner), { migrationsFolder: MIGRATIONS });
    await owner.unsafe(readFileSync(RLS_SQL_PATH, 'utf8'));
    for (const [role, bypass] of [
      [app, 'NOBYPASSRLS'],
      [sys, 'BYPASSRLS'],
    ] as const) {
      await owner.unsafe(`CREATE ROLE ${role.name} LOGIN PASSWORD '${role.password}' NOSUPERUSER ${bypass}`);
      await owner.unsafe(`GRANT USAGE ON SCHEMA public TO ${role.name}`);
      await owner.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role.name}`);
      await owner.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role.name}`);
    }
  } catch (err) {
    await drop().catch(() => {});
    throw err;
  }

  return {
    dbName,
    ownerUrl,
    appUrl: withDb(adminUrl, dbName, app),
    sysUrl: withDb(adminUrl, dbName, sys),
    drop,
  };
}
