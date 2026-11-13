/**
 * Ops diagnostics collector (`.kiro/specs/ops-diagnostics/design.md` §2).
 *
 * Answers "does the deployed code match the database it runs against, and is
 * the RLS setup coherent?" — the questions that otherwise need `wrangler tail`
 * or a psql session. Every probe is read-only, time-boxed and isolated: one
 * failing probe becomes a finding, never a 500.
 *
 * The RLS rules mirror `config/db-rls-startup.ts`, which only runs at Docker
 * process startup; Workers have no startup, so this is where they surface there.
 */
import { migrationJournal, pendingMigrations, schema as dbSchema, sites, userSites } from '@lumibase/database';
import { createSiteScopedSql } from '@lumibase/runtime';
import { count, eq, is } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import type { Context } from 'hono';
import { DbRlsConfigError, resolveDbRlsMode, type DbRlsMode } from '../../config/db-rls';
import type { AppEnv } from '../../env';
import { collectHealth, type HealthResponse } from '../../routes/health';
import { releaseOf } from './capture';
import { rootSqlState, sanitizeError, type SanitizedError } from './sanitize';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

export type FindingSeverity = 'error' | 'warn' | 'info';

export interface Finding {
  code: string;
  severity: FindingSeverity;
  message: string;
  /** What an operator should do. Commands, not prose, where possible. */
  fix?: string;
  data?: Record<string, unknown>;
}

interface RoleInfo {
  name: string;
  superuser: boolean;
  bypassRls: boolean;
}

type Probe<T> = { ok: true; value: T } | { ok: false; error: SanitizedError };

const PROBE_TIMEOUT_MS = 3000;

async function probe<T>(fn: () => Promise<T>, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: sanitizeError(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function connections(c: Context<AppEnv>): { app: Sql; system: Sql; hasSystem: boolean } | null {
  const db = c.get('runtime')?.database;
  if (!db) return null;
  return {
    app: db.getConnection() as Sql,
    system: db.getSystemConnection() as Sql,
    hasSystem: db.hasSystemConnection?.() ?? false,
  };
}

async function roleOf(sql: Sql): Promise<RoleInfo> {
  const rows = await sql`
    SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
  `;
  const r = rows[0] as { rolname: string; rolsuper: boolean; rolbypassrls: boolean } | undefined;
  if (!r) throw new Error('current role not found in pg_roles');
  return { name: r.rolname, superuser: r.rolsuper, bypassRls: r.rolbypassrls };
}

const bypasses = (r: RoleInfo) => r.superuser || r.bypassRls;

/** Every table/column the deployed code expects, from the Drizzle schema. */
function expectedColumns(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const value of Object.values(dbSchema as Record<string, unknown>)) {
    if (!is(value, PgTable)) continue;
    const cfg = getTableConfig(value);
    if (cfg.schema && cfg.schema !== 'public') continue;
    out.set(cfg.name, cfg.columns.map((col) => col.name));
  }
  return out;
}

export interface SchemaDrift {
  missingTables: string[];
  missingColumns: Array<{ table: string; columns: string[] }>;
}

export async function schemaDrift(sql: Sql): Promise<SchemaDrift> {
  const rows = (await sql`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'
  `) as Array<{ table_name: string; column_name: string }>;
  const actual = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = actual.get(r.table_name);
    if (!set) actual.set(r.table_name, (set = new Set()));
    set.add(r.column_name);
  }
  const drift: SchemaDrift = { missingTables: [], missingColumns: [] };
  for (const [table, cols] of expectedColumns()) {
    const have = actual.get(table);
    if (!have) {
      drift.missingTables.push(table);
      continue;
    }
    const missing = cols.filter((col) => !have.has(col));
    if (missing.length) drift.missingColumns.push({ table, columns: missing });
  }
  drift.missingTables.sort();
  drift.missingColumns.sort((a, b) => a.table.localeCompare(b.table));
  return drift;
}

export interface MigrationState {
  appliedCount: number;
  latestAppliedWhen: number | null;
  latestAppliedTag: string | null;
  latestExpectedTag: string | null;
  pending: string[];
  /** The DB has a migration newer than anything this build knows (code older than DB). */
  databaseAhead: boolean;
}

async function migrationState(sql: Sql): Promise<MigrationState> {
  const rows = await sql`
    SELECT count(*)::int AS n, max(created_at)::bigint AS latest FROM drizzle.__drizzle_migrations
  `;
  const r = rows[0] as { n: number; latest: string | number | null };
  const latest = r.latest === null ? null : Number(r.latest);
  const known = latest === null ? undefined : migrationJournal.find((m) => m.when === latest);
  const newestExpected = migrationJournal.at(-1);
  return {
    appliedCount: r.n,
    latestAppliedWhen: latest,
    latestAppliedTag: known?.tag ?? null,
    latestExpectedTag: newestExpected?.tag ?? null,
    pending: pendingMigrations(latest).map((m) => m.tag),
    databaseAhead: latest !== null && newestExpected !== undefined && latest > newestExpected.when,
  };
}

const RLS_TABLES = ['lumibase_sites', 'lumibase_api_keys', 'lumibase_items', 'lumibase_ops_errors'];

async function rlsState(sql: Sql) {
  const policies = await sql`
    SELECT count(*)::int AS n FROM pg_policies WHERE policyname = 'site_isolation_permit'
  `;
  const tables = (await sql`
    SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE relkind = 'r' AND relname = ANY(${RLS_TABLES})
  `) as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
  return {
    policiesInstalled: (policies[0] as { n: number }).n > 0,
    tables: Object.fromEntries(
      tables.map((t) => [t.relname, { enabled: t.relrowsecurity, forced: t.relforcerowsecurity }]),
    ) as Record<string, { enabled: boolean; forced: boolean }>,
  };
}

export interface Diagnostics {
  release: { version: string | null; gitSha: string | null; label: string | null };
  env: string | null;
  runtime: string | null;
  rls: {
    mode: DbRlsMode | null;
    modeError?: string;
    hasSystemConnection: boolean;
    appRole: RoleInfo | null;
    systemRole: RoleInfo | null;
    policiesInstalled: boolean | null;
    tables: Record<string, { enabled: boolean; forced: boolean }>;
  };
  migrations: MigrationState | null;
  schemaDrift: SchemaDrift | null;
  opsErrorCapture: { tableExists: boolean | null; last24h: number | null };
  health: HealthResponse | null;
  findings: Finding[];
  /** Probes that could not run, with the sanitized reason. */
  probeErrors: Record<string, SanitizedError>;
}

const MIGRATE_FIX =
  'Apply migrations against the production DATABASE_URL: `DATABASE_URL=<prod> pnpm db:migrate` ' +
  '(then re-apply `packages/database/migrations/rls-policies.sql` if the release notes say so).';

export async function collectDiagnostics(c: Context<AppEnv>): Promise<Diagnostics> {
  const findings: Finding[] = [];
  const probeErrors: Record<string, SanitizedError> = {};
  const env = c.env;

  let mode: DbRlsMode | null = null;
  let modeError: string | undefined;
  try {
    mode = resolveDbRlsMode(env);
  } catch (err) {
    modeError = err instanceof DbRlsConfigError ? err.message : String(err);
    findings.push({
      code: 'RLS_FLAG_INVALID',
      severity: 'error',
      message: `LUMIBASE_DB_RLS is invalid: ${modeError}. Every tenant request answers 503 RLS_MISCONFIGURED.`,
      fix: 'Set LUMIBASE_DB_RLS to `off` or `enforce`.',
    });
  }

  const conns = connections(c);
  const diag: Diagnostics = {
    release: { version: env?.LUMIBASE_VERSION ?? null, gitSha: env?.LUMIBASE_GIT_SHA ?? null, label: releaseOf(env) },
    env: env?.LUMIBASE_ENV ?? null,
    runtime: env?.LUMIBASE_RUNTIME ?? null,
    rls: {
      mode,
      ...(modeError ? { modeError } : {}),
      hasSystemConnection: conns?.hasSystem ?? false,
      appRole: null,
      systemRole: null,
      policiesInstalled: null,
      tables: {},
    },
    migrations: null,
    schemaDrift: null,
    opsErrorCapture: { tableExists: null, last24h: null },
    health: null,
    findings,
    probeErrors,
  };

  if (!diag.release.gitSha || diag.release.gitSha === 'unknown') {
    findings.push({
      code: 'RELEASE_UNKNOWN',
      severity: 'info',
      message: 'LUMIBASE_GIT_SHA is not set; errors cannot be tied to a commit.',
      fix: 'Deploy through the Deploy CMS workflow, which injects LUMIBASE_VERSION/LUMIBASE_GIT_SHA.',
    });
  }

  if (!conns) {
    findings.push({ code: 'NO_DATABASE_RUNTIME', severity: 'error', message: 'No database provider on the runtime.' });
    return diag;
  }

  const [appRole, systemRole, rls, migrations, drift, opsTable, health] = await Promise.all([
    probe(() => roleOf(conns.app)),
    probe(() => roleOf(conns.system)),
    probe(() => rlsState(conns.system)),
    probe(() => migrationState(conns.system)),
    probe(() => schemaDrift(conns.system)),
    probe(async () => {
      const rows = await conns.system`SELECT to_regclass('public.lumibase_ops_errors') IS NOT NULL AS exists`;
      const exists = Boolean((rows[0] as { exists: boolean }).exists);
      if (!exists) return { exists, last24h: null };
      const n = await conns.system`
        SELECT count(*)::int AS n FROM lumibase_ops_errors WHERE created_at > now() - interval '24 hours'
      `;
      return { exists, last24h: (n[0] as { n: number }).n };
    }),
    probe(() => collectHealth(c), 8000),
  ]);

  if (appRole.ok) diag.rls.appRole = appRole.value;
  else probeErrors.appRole = appRole.error;
  if (systemRole.ok) diag.rls.systemRole = systemRole.value;
  else probeErrors.systemRole = systemRole.error;
  if (rls.ok) {
    diag.rls.policiesInstalled = rls.value.policiesInstalled;
    diag.rls.tables = rls.value.tables;
  } else probeErrors.rls = rls.error;
  if (health.ok) diag.health = health.value;
  else probeErrors.health = health.error;

  if (opsTable.ok) {
    diag.opsErrorCapture = { tableExists: opsTable.value.exists, last24h: opsTable.value.last24h };
    if (!opsTable.value.exists) {
      findings.push({
        code: 'OPS_ERRORS_TABLE_MISSING',
        severity: 'warn',
        message: 'lumibase_ops_errors does not exist, so 5xx responses are not being captured.',
        fix: MIGRATE_FIX,
      });
    }
  } else probeErrors.opsErrorCapture = opsTable.error;

  if (migrations.ok) {
    diag.migrations = migrations.value;
    if (migrations.value.pending.length > 0) {
      findings.push({
        code: 'MIGRATIONS_PENDING',
        severity: 'error',
        message:
          `The deployed code expects ${migrations.value.pending.length} migration(s) the database has not applied: ` +
          migrations.value.pending.join(', '),
        fix: MIGRATE_FIX,
        data: { pending: migrations.value.pending },
      });
    }
    if (migrations.value.databaseAhead) {
      findings.push({
        code: 'DATABASE_AHEAD_OF_CODE',
        severity: 'warn',
        message: 'The database has a migration newer than this build knows; the deployed code may be a rollback.',
      });
    }
  } else {
    probeErrors.migrations = migrations.error;
    findings.push({
      code: 'MIGRATIONS_UNREADABLE',
      severity: 'warn',
      message: 'Could not read drizzle.__drizzle_migrations (see probeErrors.migrations).',
    });
  }

  if (drift.ok) {
    diag.schemaDrift = drift.value;
    if (drift.value.missingTables.length || drift.value.missingColumns.length) {
      findings.push({
        code: 'SCHEMA_DRIFT',
        severity: 'error',
        message:
          'The database is missing tables/columns the deployed code selects; any query touching them fails ' +
          '(SQLSTATE 42P01 / 42703).',
        fix: MIGRATE_FIX,
        data: { ...drift.value },
      });
    }
  } else probeErrors.schemaDrift = drift.error;

  // RLS coherence — same rules as config/db-rls-startup.ts.
  const app = diag.rls.appRole;
  const sys = diag.rls.systemRole;
  if (mode === 'enforce') {
    if (!conns.hasSystem) {
      findings.push({
        code: 'ENFORCE_WITHOUT_SYSTEM_CONNECTION',
        severity: 'error',
        message: 'LUMIBASE_DB_RLS=enforce without a system connection: tenant requests answer 503 RLS_MISCONFIGURED.',
        fix: 'Bind HYPERDRIVE_SYSTEM (Workers) or set DATABASE_SYSTEM_URL (Docker) to a BYPASSRLS role.',
      });
    }
    if (sys && !bypasses(sys)) {
      findings.push({
        code: 'SYSTEM_ROLE_CANNOT_BYPASS',
        severity: 'error',
        message: `System role "${sys.name}" lacks BYPASSRLS: workers, cron and system routes see no rows.`,
        fix: `ALTER ROLE "${sys.name}" BYPASSRLS;`,
      });
    }
    if (app && bypasses(app)) {
      findings.push({
        code: 'APP_ROLE_BYPASSES_RLS_UNDER_ENFORCE',
        severity: 'warn',
        message: `App role "${app.name}" bypasses RLS, so enforce mode isolates nothing.`,
        fix: 'Connect DATABASE_URL / HYPERDRIVE with a NOSUPERUSER NOBYPASSRLS role.',
      });
    }
    if (diag.rls.policiesInstalled === false) {
      findings.push({
        code: 'ENFORCE_WITHOUT_POLICIES',
        severity: 'warn',
        message: 'LUMIBASE_DB_RLS=enforce but rls-policies.sql is not installed: nothing is enforced.',
        fix: 'psql "$DATABASE_URL" -f packages/database/migrations/rls-policies.sql',
      });
    }
  } else if (mode === 'off' && app && !bypasses(app) && diag.rls.policiesInstalled) {
    findings.push({
      code: 'RLS_POLICIES_WITHOUT_FLAG',
      severity: 'error',
      message:
        `rls-policies.sql is installed and app role "${app.name}" does not bypass RLS, but LUMIBASE_DB_RLS is off: ` +
        'request reads of RLS tables (sites, items, keys…) see no rows.',
      fix: 'Set LUMIBASE_DB_RLS=enforce with a system connection, or connect the app with a BYPASSRLS role.',
    });
  }

  if (diag.health) {
    for (const [service, status] of Object.entries(diag.health.services)) {
      if (status !== 'healthy') {
        findings.push({
          code: 'SERVICE_UNHEALTHY',
          severity: service === 'database' ? 'error' : 'warn',
          message: `${service} is ${status}.`,
          data: { service, status },
        });
      }
    }
  }

  const order: Record<FindingSeverity, number> = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return diag;
}

// ---------------------------------------------------------------------------
// Per-site probe
// ---------------------------------------------------------------------------

export interface SiteProbe {
  siteId: string;
  rlsMode: DbRlsMode | null;
  /** Row exists, read with the system role (bypasses RLS). */
  exists: Probe<boolean>;
  /** `GET /api/v1/site`'s exact statement, on the connection a request would use. */
  requestPath: Probe<{ found: boolean }> & { connection: 'app (site-scoped)' | 'app (unscoped)' };
  /** The same statement under the site's RLS scope, whatever the flag says. */
  underRlsScope: Probe<{ found: boolean }>;
  memberCount: Probe<number>;
  findings: Finding[];
}

export async function probeSite(c: Context<AppEnv>, siteId: string): Promise<SiteProbe | null> {
  const conns = connections(c);
  if (!conns) return null;
  let mode: DbRlsMode | null = null;
  try {
    mode = resolveDbRlsMode(c.env);
  } catch {
    mode = null;
  }

  const sysDb = drizzle(conns.system as never, { schema: dbSchema });
  const scopedDb = drizzle(createSiteScopedSql(conns.app as never, siteId) as never, { schema: dbSchema });
  const requestDb = mode === 'enforce' ? scopedDb : drizzle(conns.app as never, { schema: dbSchema });

  // Select every column, exactly like the route, but return only "found".
  const siteStatement = async (db: typeof sysDb) => {
    const rows = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    return { found: rows.length > 0 };
  };

  const [exists, requestPath, underRlsScope, memberCount] = await Promise.all([
    probe(async () => {
      const rows = await conns.system`SELECT 1 FROM lumibase_sites WHERE id = ${siteId} LIMIT 1`;
      return rows.length > 0;
    }),
    probe(() => siteStatement(requestDb)),
    probe(() => siteStatement(scopedDb)),
    probe(async () => {
      const [row] = await sysDb.select({ n: count() }).from(userSites).where(eq(userSites.siteId, siteId));
      return Number(row?.n ?? 0);
    }),
  ]);

  const findings: Finding[] = [];
  if (exists.ok && !exists.value) {
    findings.push({ code: 'SITE_NOT_FOUND', severity: 'error', message: `No lumibase_sites row with id "${siteId}".` });
  }
  if (!requestPath.ok) {
    const state = rootSqlState(requestPath.error);
    findings.push({
      code: 'SITE_QUERY_FAILS',
      severity: 'error',
      message:
        `GET /api/v1/site fails for this site` +
        (state ? ` with SQLSTATE ${state}` : '') +
        (state === '42703' ? ' (undefined column — a migration is missing).' : '.'),
      fix: state === '42703' || state === '42P01' ? MIGRATE_FIX : undefined,
      data: { error: requestPath.error },
    });
  } else if (exists.ok && exists.value && !requestPath.value.found) {
    findings.push({
      code: 'SITE_ROW_HIDDEN_BY_RLS',
      severity: 'error',
      message:
        'The site row exists but the request connection cannot see it, so GET /api/v1/site answers 404. ' +
        'Row-level security is filtering it (scope not set, or the policy predicate does not match).',
      fix: 'Run GET /api/v1/ops/diagnostics and resolve its RLS findings.',
    });
  }

  return {
    siteId,
    rlsMode: mode,
    exists,
    requestPath: { ...requestPath, connection: mode === 'enforce' ? 'app (site-scoped)' : 'app (unscoped)' },
    underRlsScope,
    memberCount,
    findings,
  };
}
