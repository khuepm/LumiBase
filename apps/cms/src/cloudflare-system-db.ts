/**
 * System-role database for Cloudflare `scheduled` and `queue` handlers (B130,
 * `.kiro/specs/rls-request-scope/` design §4).
 *
 * Cron sweeps and queue consumers run outside a request, mostly across sites
 * with no site scope, so under `LUMIBASE_DB_RLS=enforce` they need a role that
 * bypasses RLS. That role is bound as the optional `HYPERDRIVE_SYSTEM`
 * Hyperdrive config. Resolution:
 *
 *   HYPERDRIVE_SYSTEM → (flag off only) HYPERDRIVE → (development only)
 *   DATABASE_SYSTEM_URL ?? DATABASE_URL
 *
 * With the flag `off` and no `HYPERDRIVE_SYSTEM`, this is the same
 * `createDb(HYPERDRIVE.connectionString)` the handlers used before.
 *
 * Every `apps/cms/src/cloudflare*.ts` file builds its db here; tripwire T3 in
 * `__tests__/rls-scope.wiring.test.ts` forbids `createDb(` and
 * `.connectionString` in the other ones.
 *
 * Worker-safe: no Node built-ins.
 */
import { createDb, type Database } from '@lumibase/database';
import { DbRlsConfigError, parseDbRlsMode } from './config/db-rls';
import type { Bindings } from './env';

type SystemDbEnv = Pick<
  Bindings,
  'HYPERDRIVE' | 'HYPERDRIVE_SYSTEM' | 'LUMIBASE_DB_RLS' | 'LUMIBASE_ENV' | 'DATABASE_URL' | 'DATABASE_SYSTEM_URL'
>;

export type CloudflareSystemDb = { db: Database; error?: undefined } | { db?: undefined; error: string };

export function resolveCloudflareSystemConnectionString(
  env: SystemDbEnv,
): { connectionString: string; error?: undefined } | { connectionString?: undefined; error: string } {
  let mode;
  try {
    mode = parseDbRlsMode(env.LUMIBASE_DB_RLS);
  } catch (err) {
    if (err instanceof DbRlsConfigError) return { error: err.message };
    throw err;
  }
  const isDev = env.LUMIBASE_ENV === 'development';
  const system = env.HYPERDRIVE_SYSTEM?.connectionString ?? (isDev ? env.DATABASE_SYSTEM_URL : undefined);
  if (system) return { connectionString: system };
  if (mode === 'enforce') {
    return {
      error:
        'LUMIBASE_DB_RLS=enforce requires a HYPERDRIVE_SYSTEM binding (a role with BYPASSRLS) ' +
        'for scheduled and queue handlers.',
    };
  }
  const main = env.HYPERDRIVE?.connectionString ?? (isDev ? env.DATABASE_URL : undefined);
  if (main) return { connectionString: main };
  return { error: 'HYPERDRIVE binding is not configured (or development DATABASE_URL).' };
}

/** Build the system db, or explain why it cannot be built. Never throws. */
export function createCloudflareSystemDb(env: SystemDbEnv): CloudflareSystemDb {
  const resolved = resolveCloudflareSystemConnectionString(env);
  if (resolved.error !== undefined) return { error: resolved.error };
  return { db: createDb(resolved.connectionString) };
}
