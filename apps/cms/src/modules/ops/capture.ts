/**
 * Operator error capture writer (`.kiro/specs/ops-diagnostics/design.md` §1).
 *
 * Persists one sanitized row per 5xx response to `lumibase_ops_errors` so an
 * operator (or their agent, through the ops plane / MCP) can look a failure up
 * by the `requestId` the client saw — without `wrangler tail` or Logpush.
 *
 * Contract: best-effort and invisible to the request. The write runs detached,
 * on the system connection (the table has RLS forced with no policy), never
 * throws, is rate-capped per isolate, and opportunistically prunes rows past
 * retention so no new cron is needed.
 */
import type { Context } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type { AppEnv } from '../../env';
import { runDetached } from '../../lib/detached';
import { sanitizeError, sanitizeStack, type SanitizedError } from './sanitize';

export const OPS_ERROR_RETENTION_DAYS = 14;
const MAX_WRITES_PER_MINUTE = 60;
const PRUNE_SAMPLE_RATE = 0.02;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = ((strings: TemplateStringsArray, ...values: any[]) => Promise<unknown>) & {
  json?: (value: unknown) => unknown;
};

export interface OpsErrorRecord {
  id: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  siteId: string | null;
  principal: string | null;
  release: string | null;
  errorCode: string | null;
  error: SanitizedError | null;
  stack: string | null;
}

// Per-isolate token bucket: an error storm must not turn into a write storm.
let windowStart = 0;
let windowWrites = 0;

export function takeCaptureSlot(now = Date.now()): boolean {
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowWrites = 0;
  }
  if (windowWrites >= MAX_WRITES_PER_MINUTE) return false;
  windowWrites += 1;
  return true;
}

/** Test seam. */
export function resetCaptureRateLimit(): void {
  windowStart = 0;
  windowWrites = 0;
}

export function releaseOf(env: AppEnv['Bindings'] | undefined): string | null {
  const version = env?.LUMIBASE_VERSION;
  const sha = env?.LUMIBASE_GIT_SHA;
  if (!version && !sha) return null;
  return `${version ?? 'unknown'}+${sha ?? 'unknown'}`;
}

function principalOf(c: Context<AppEnv>): string | null {
  const auth = c.get('auth');
  if (!auth) return null;
  if (auth.apiKeyId) return `apikey:${auth.apiKeyId}`;
  if (auth.userId) return `user:${auth.userId}`;
  return auth.type ?? null;
}

export function buildOpsErrorRecord(
  c: Context<AppEnv>,
  input: { err?: unknown; status: number; errorCode?: string | null },
): OpsErrorRecord {
  return {
    id: uuidv7(),
    requestId: c.get('requestId') ?? 'unknown',
    method: c.req.method,
    path: c.req.path,
    status: input.status,
    siteId: c.get('siteId') ?? null,
    principal: principalOf(c),
    release: releaseOf(c.env),
    errorCode: input.errorCode ?? null,
    error: input.err === undefined ? null : sanitizeError(input.err),
    stack: input.err === undefined ? null : (sanitizeStack(input.err) ?? null),
  };
}

function systemSqlOf(c: Context<AppEnv>): Sql | null {
  try {
    const db = c.get('runtime')?.database;
    return db ? (db.getSystemConnection() as Sql) : null;
  } catch {
    return null;
  }
}

export async function writeOpsError(sql: Sql, rec: OpsErrorRecord, prune = Math.random() < PRUNE_SAMPLE_RATE): Promise<void> {
  const errorJson = rec.error === null ? null : JSON.stringify(rec.error);
  await sql`
    INSERT INTO lumibase_ops_errors
      (id, request_id, method, path, status, site_id, principal, release, error_code, error, stack)
    VALUES
      (${rec.id}, ${rec.requestId}, ${rec.method}, ${rec.path}, ${rec.status}, ${rec.siteId},
       ${rec.principal}, ${rec.release}, ${rec.errorCode}, ${errorJson}::jsonb, ${rec.stack})
  `;
  if (prune) {
    await sql`
      DELETE FROM lumibase_ops_errors
      WHERE created_at < now() - make_interval(days => ${OPS_ERROR_RETENTION_DAYS})
    `;
  }
}

/**
 * Record a 5xx for this request (once). Safe to call from `onError` and from
 * the logger's `finally`; the second call for the same request is a no-op.
 */
export function captureOpsError(
  c: Context<AppEnv>,
  input: { err?: unknown; status: number; errorCode?: string | null | Promise<string | null> },
): void {
  try {
    if (input.status < 500) return;
    if (c.get('opsErrorCaptured')) return;
    c.set('opsErrorCaptured', true);
    if (!takeCaptureSlot()) return;
    const sql = systemSqlOf(c);
    if (!sql) return;
    const rec = buildOpsErrorRecord(c, { err: input.err, status: input.status });
    const code = Promise.resolve(input.errorCode ?? null).catch(() => null);
    runDetached(
      c,
      code.then((errorCode) => writeOpsError(sql, { ...rec, errorCode })).catch((err: unknown) => {
        // Table missing (migration 0029 not applied) or DB down: the console line
        // from onError/logger is still there; never fail the request over this.
        console.warn('[ops] error capture write failed', {
          requestId: rec.requestId,
          err: sanitizeError(err),
        });
      }),
    );
  } catch {
    // never let diagnostics break the response
  }
}
