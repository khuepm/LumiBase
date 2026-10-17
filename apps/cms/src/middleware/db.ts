import { schema, type Database } from '@lumibase/database';
import { createSiteScopedSql, isSiteScopedSql, scopedSiteIdOf, unscopedSqlOf } from '@lumibase/runtime';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Context, MiddlewareHandler } from 'hono';
import postgres from 'postgres';
import { DbRlsConfigError, resolveDbRlsMode, rlsErrorBody, type DbRlsMode } from '../config/db-rls';
import type { AppEnv } from '../env';

/**
 * Per-request database clients (B130, `.kiro/specs/rls-request-scope/`).
 *
 * Every request db in `apps/cms/src` is built here (tripwire T2 in
 * `__tests__/rls-scope.wiring.test.ts`):
 *
 * - `withDb()` — the app-role db on `c.get('db')`. With
 *   `LUMIBASE_DB_RLS=enforce` and a `siteId` on the context it is wrapped by
 *   `createSiteScopedSql`, so every statement runs in its own transaction with
 *   `app.site_id` set. `withDb` runs right after `withTenant` in `index.ts`, so
 *   the middlewares that read RLS tables before the handler are scoped too.
 * - `scopedDbFor(c, siteId)` — for routers that learn the site only in the
 *   handler (`deliver`, public shares, pageviews hit, email unsubscribe, git
 *   webhook/preview).
 * - `withSystemDb()` / `systemDbFor(c)` — the system-role db (BYPASSRLS,
 *   unscoped) for system routes and writes that legitimately cross sites.
 *
 * With the flag `off` (default) these behave as before: one unscoped app db,
 * and the "system" db is that same connection unless `DATABASE_SYSTEM_URL` /
 * `HYPERDRIVE_SYSTEM` is configured.
 *
 * Connection resolution order (unchanged):
 * 1. In local development: create a fresh connection per request and close it
 *    when the request ends. This avoids Wrangler's strict "Cannot perform I/O
 *    on behalf of a different request" error caused by sharing TCP sockets
 *    across async request boundaries.
 * 2. If a RuntimeContext is available (`c.get('runtime')`), use its
 *    DatabaseProvider — this works for both Cloudflare and Docker modes.
 * 3. Fallback: use the Hyperdrive binding directly.
 */

type Kind = 'app' | 'system';
type AppContext = Context<AppEnv>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySql = postgres.Sql<any>;

type Resolved =
  | { ok: true; sql: AnySql; hasSystemConnection: boolean }
  | { ok: false; status: 500; body: unknown };

function isDevEnv(c: AppContext): boolean {
  return c.env.LUMIBASE_ENV === 'development' || process.env.LUMIBASE_ENV === 'development';
}

function resolveSql(c: AppContext, kind: Kind): Resolved {
  if (isDevEnv(c)) {
    const appUrl =
      c.env.DATABASE_URL || process.env.DATABASE_URL || 'postgresql://lumibase:lumibase@localhost:5432/lumibase';
    const systemUrl = c.env.DATABASE_SYSTEM_URL || process.env.DATABASE_SYSTEM_URL;
    const sql = postgres(kind === 'system' && systemUrl ? systemUrl : appUrl, {
      max: 10,
      idle_timeout: 0.1,
      prepare: false,
    });
    return { ok: true, sql, hasSystemConnection: Boolean(systemUrl) };
  }

  // Prefer RuntimeContext if available (set by withRuntime middleware).
  const runtime = c.get('runtime');
  if (runtime) {
    // DatabaseProvider returns a postgres.Sql instance (from both Cloudflare
    // and Docker adapters). The interface types it as `unknown` to avoid
    // coupling to postgres-js.
    const db = runtime.database;
    // Optional calls: older providers (and test doubles) without the B130
    // methods behave as "no dedicated system connection".
    const hasSystemConnection = db.hasSystemConnection?.() ?? false;
    const sql = (
      kind === 'system' && hasSystemConnection ? db.getSystemConnection() : db.getConnection()
    ) as AnySql;
    return { ok: true, sql, hasSystemConnection };
  }

  // Fallback: direct Hyperdrive binding (backward compatibility).
  const system = c.env.HYPERDRIVE_SYSTEM;
  const hyperdrive = kind === 'system' && system ? system : c.env.HYPERDRIVE;
  if (!hyperdrive) {
    return {
      ok: false,
      status: 500,
      body: { error: 'Database connection is not configured. Ensure runtime or HYPERDRIVE binding is available.' },
    };
  }
  // Same client options as `createDb` in @lumibase/database.
  const sql = postgres(hyperdrive.connectionString, { max: 5, prepare: false });
  return { ok: true, sql, hasSystemConnection: Boolean(system?.connectionString) };
}

/** Is a dedicated system connection configured? (Never opens one.) */
function hasDedicatedSystemConnection(c: AppContext): boolean {
  if (isDevEnv(c)) return Boolean(c.env.DATABASE_SYSTEM_URL || process.env.DATABASE_SYSTEM_URL);
  const db = c.get('runtime')?.database;
  if (db) return db.hasSystemConnection?.() ?? false;
  return Boolean(c.env.HYPERDRIVE_SYSTEM?.connectionString);
}

function modeOf(c: AppContext): DbRlsMode | DbRlsConfigError {
  try {
    return resolveDbRlsMode(c.env);
  } catch (err) {
    if (err instanceof DbRlsConfigError) return err;
    throw err;
  }
}

function misconfigured(c: AppContext, message: string) {
  console.error('[db] RLS misconfigured', { requestId: c.get('requestId'), message });
  return c.json(rlsErrorBody('RLS_MISCONFIGURED', message), 503);
}

const MISSING_SYSTEM =
  'LUMIBASE_DB_RLS=enforce needs a system connection: set DATABASE_SYSTEM_URL (Docker) ' +
  'or bind HYPERDRIVE_SYSTEM (Workers) to a BYPASSRLS role.';

/**
 * Per-request cache of scoped dbs, so one handler that calls
 * `scopedDbFor(c, x)` several times builds one drizzle instance.
 */
const scopedCache = new WeakMap<object, Map<string, Database>>();

/** The postgres.js client under a drizzle db (drizzle sets `$client`). */
export function dbClientOf(db: Database | undefined): unknown {
  return (db as { $client?: unknown } | undefined)?.$client;
}

function scoped(sql: AnySql, siteId: string): Database {
  return drizzle(createSiteScopedSql(sql, siteId), { schema }) as unknown as Database;
}

export const withDb = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (c.get('db')) {
    await next();
    return;
  }

  const mode = modeOf(c);
  if (mode instanceof DbRlsConfigError) return misconfigured(c, mode.message);

  const resolved = resolveSql(c, 'app');
  if (!resolved.ok) return c.json(resolved.body as Record<string, unknown>, resolved.status);

  if (mode === 'enforce') {
    if (!resolved.hasSystemConnection) return misconfigured(c, MISSING_SYSTEM);
    const siteId = c.get('siteId');
    // Without a siteId the db stays unscoped: on a NOBYPASSRLS role it sees no
    // rows of RLS tables, which is the fail-closed outcome. Routers that learn
    // the site later re-scope via `scopedDbFor`.
    c.set('db', siteId ? scoped(resolved.sql, siteId) : (drizzle(resolved.sql, { schema }) as unknown as Database));
  } else {
    c.set('db', drizzle(resolved.sql, { schema }) as unknown as Database);
  }
  await next();
};

/**
 * Use the system-role db as `c.get('db')` for this router (setup, recovery,
 * SCIM, git OAuth). Unscoped, BYPASSRLS under enforce.
 */
export const withSystemDb = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (c.get('db')) {
    await next();
    return;
  }
  const mode = modeOf(c);
  if (mode instanceof DbRlsConfigError) return misconfigured(c, mode.message);
  const resolved = resolveSql(c, 'system');
  if (!resolved.ok) return c.json(resolved.body as Record<string, unknown>, resolved.status);
  if (mode === 'enforce' && !resolved.hasSystemConnection) return misconfigured(c, MISSING_SYSTEM);
  const db = drizzle(resolved.sql, { schema }) as unknown as Database;
  c.set('systemDb', db);
  c.set('db', db);
  await next();
};

/**
 * The system-role db for one statement that must cross sites inside a
 * request (e.g. auditing an API key under the key's own site). Memoised on
 * the context.
 *
 * Flag off without a dedicated system connection: returns `c.get('db')` when
 * set, which is the same connection as today.
 */
export function systemDbFor(c: AppContext): Database {
  const existing = c.get('systemDb');
  if (existing) return existing;
  const mode = modeOf(c);
  if (mode instanceof DbRlsConfigError) throw mode;

  // Flag off with no dedicated system connection: the request db IS the
  // system db, exactly as before (no new connection, no runtime lookup).
  const current = c.get('db');
  if (mode === 'off' && !hasDedicatedSystemConnection(c) && current && !isSiteScopedSql(dbClientOf(current))) {
    c.set('systemDb', current);
    return current;
  }

  const resolved = resolveSql(c, 'system');
  if (!resolved.ok) throw new Error('Database connection is not configured.');
  if (mode === 'enforce' && !resolved.hasSystemConnection) throw new DbRlsConfigError(MISSING_SYSTEM);
  const db = drizzle(resolved.sql, { schema }) as unknown as Database;
  c.set('systemDb', db);
  return db;
}

/**
 * The app-role db scoped to `siteId`, for routers whose site comes from the
 * path or a verified token rather than `withTenant`. Requires `withDb()`.
 *
 * Flag off: returns `c.get('db')` unchanged (no scope, as before).
 */
export function scopedDbFor(c: AppContext, siteId: string): Database {
  const current = c.get('db');
  if (!current) throw new Error('scopedDbFor: withDb() must run before the handler');
  const mode = modeOf(c);
  if (mode instanceof DbRlsConfigError) throw mode;
  if (mode === 'off') return current;
  if (scopedSiteIdOf(dbClientOf(current)) === siteId) return current;

  let perSite = scopedCache.get(c);
  if (!perSite) {
    perSite = new Map();
    scopedCache.set(c, perSite);
  }
  let db = perSite.get(siteId);
  if (!db) {
    db = scoped(unscopedSqlOf(dbClientOf(current) as AnySql), siteId);
    perSite.set(siteId, db);
  }
  return db;
}
