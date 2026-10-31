/**
 * `LUMIBASE_DB_RLS` flag (B130, `.kiro/specs/rls-request-scope/`).
 *
 * - `off` (default): request queries run on the plain pool, as before. The
 *   app must connect with a role that bypasses RLS (superuser or BYPASSRLS).
 * - `enforce`: every request statement runs in its own transaction with
 *   `app.site_id` set (`createSiteScopedSql`), and worker/cron/system paths use
 *   the BYPASSRLS system connection (`DATABASE_SYSTEM_URL` / `HYPERDRIVE_SYSTEM`).
 *
 * Any other value is a configuration error: a typo must never silently mean
 * `off`, so callers fail closed.
 *
 * Worker-safe: no Node built-ins.
 */
export type DbRlsMode = 'off' | 'enforce';

export class DbRlsConfigError extends Error {
  readonly code = 'RLS_MISCONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'DbRlsConfigError';
  }
}

export function parseDbRlsMode(raw: string | undefined | null): DbRlsMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return 'off';
  if (v === 'enforce') return 'enforce';
  throw new DbRlsConfigError(
    `LUMIBASE_DB_RLS must be "off" or "enforce" (got ${JSON.stringify(raw)}).`,
  );
}

/** Read the flag from Worker bindings first, then `process.env` (Docker). */
export function resolveDbRlsMode(env: { LUMIBASE_DB_RLS?: string } | undefined): DbRlsMode {
  const fromEnv = env?.LUMIBASE_DB_RLS;
  const fromProcess =
    typeof process !== 'undefined' ? process.env?.LUMIBASE_DB_RLS : undefined;
  return parseDbRlsMode(fromEnv ?? fromProcess);
}

/** The JSON error body every RLS config/scope failure returns. */
export function rlsErrorBody(code: 'RLS_MISCONFIGURED' | 'RLS_UNAVAILABLE', message: string) {
  return { errors: [{ code, message }] };
}
