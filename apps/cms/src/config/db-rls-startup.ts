/**
 * Node/Docker startup check for `LUMIBASE_DB_RLS` (B130,
 * `.kiro/specs/rls-request-scope/` design §4). Called by `serve.ts` right
 * after the runtime is built, for every process role.
 *
 * - invalid flag value → throw (the process does not start);
 * - `enforce` without `DATABASE_SYSTEM_URL` → throw;
 * - `enforce`: the system role must bypass RLS (superuser or BYPASSRLS), else
 *   workers and cron would see no rows → throw. If the APP role bypasses RLS
 *   the backstop is inert → loud warning;
 * - `off`: if the app role does NOT bypass RLS and the policy pair from
 *   `rls-policies.sql` is installed, every request read sees no rows (the
 *   operator applied the file but forgot the flag) → loud warning.
 *
 * Workers have no process startup: there the request middlewares answer 503
 * `RLS_MISCONFIGURED` instead (`middleware/db.ts`).
 */
import { parseDbRlsMode, type DbRlsMode } from './db-rls';

/** Minimal postgres.js tagged-template surface used here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RoleSql = (strings: TemplateStringsArray, ...values: any[]) => any;

/** The runtime `DatabaseProvider` (both connections are postgres.js clients). */
export interface DbRlsStartupDatabase {
  getConnection(): unknown;
  getSystemConnection(): unknown;
  hasSystemConnection(): boolean;
}

export interface DbRlsStartupDeps {
  readonly rawMode: string | undefined;
  readonly database: DbRlsStartupDatabase;
  readonly warn?: (line: string) => void;
  readonly log?: (line: string) => void;
}

interface RoleRow {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolname: string;
}

async function roleOf(sql: RoleSql): Promise<RoleRow> {
  const rows = (await sql`
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
  `) as RoleRow[];
  const row = rows[0];
  if (!row) throw new Error('[db-rls] could not read the current database role from pg_roles');
  return row;
}

const bypasses = (r: RoleRow) => r.rolsuper || r.rolbypassrls;

export async function assertDbRlsStartup(deps: DbRlsStartupDeps): Promise<DbRlsMode> {
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  const log = deps.log ?? ((l: string) => console.log(l));
  const mode = parseDbRlsMode(deps.rawMode);
  const appSql = () => deps.database.getConnection() as RoleSql;
  const systemSql = () => deps.database.getSystemConnection() as RoleSql;
  const hasSystemConnection = deps.database.hasSystemConnection();

  if (mode === 'enforce') {
    if (!hasSystemConnection) {
      throw new Error(
        '[db-rls] LUMIBASE_DB_RLS=enforce requires DATABASE_SYSTEM_URL (a role with BYPASSRLS) ' +
          'for workers, cron and system routes.',
      );
    }
    const sys = await roleOf(systemSql());
    if (!bypasses(sys)) {
      throw new Error(
        `[db-rls] LUMIBASE_DB_RLS=enforce: the DATABASE_SYSTEM_URL role "${sys.rolname}" must have ` +
          'BYPASSRLS (or be a superuser); otherwise workers and cron see no rows.',
      );
    }
    const app = await roleOf(appSql());
    if (bypasses(app)) {
      warn(
        `[db-rls] WARNING: LUMIBASE_DB_RLS=enforce but the DATABASE_URL role "${app.rolname}" ` +
          'bypasses RLS (superuser or BYPASSRLS), so the RLS backstop enforces nothing. ' +
          'Connect the app with a NOSUPERUSER NOBYPASSRLS role.',
      );
    }
    log(`[db-rls] request-path RLS scope: enforce (app role "${app.rolname}", system role "${sys.rolname}")`);
    return mode;
  }

  // Off is today's behaviour: the probe is advisory only, so a database that is
  // not reachable yet at boot must not stop the process here.
  try {
    const app = await roleOf(appSql());
    if (!bypasses(app)) {
      const policies = (await appSql()`
        SELECT 1 FROM pg_policies WHERE policyname = 'site_isolation_permit' LIMIT 1
      `) as unknown[];
      if (policies.length > 0) {
        warn(
          `[db-rls] WARNING: the DATABASE_URL role "${app.rolname}" does not bypass RLS and ` +
            'rls-policies.sql is applied, but LUMIBASE_DB_RLS is off: request reads will see no rows. ' +
            'Set LUMIBASE_DB_RLS=enforce with DATABASE_SYSTEM_URL, or connect with a BYPASSRLS role.',
        );
      }
    }
  } catch {
    // advisory probe failed (database not reachable yet); nothing to report
  }
  return mode;
}
