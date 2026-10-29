/**
 * Bounded audit for refused AI decision requests (#564, B147).
 *
 * `authorizeDecision` refusals (`403 FORBIDDEN`) come from callers who are
 * not allowed to decide: publishable keys, frontend sessions, members without
 * `ai:decide`, keys of another site, unresolved principals. Those credentials
 * can be cheap or public, so writing one `ai_decision` row per refused request
 * would let anyone turn free requests into audit-table writes on the shared
 * database. Instead refusals are aggregated per window:
 *
 *   key = dra:{siteId}:{window}:{kind}:{subjectHash}:{reason}
 *
 * - `kind`/`subjectHash`: the principal (`user` / `api_key` / `dev`, keyed hash
 *   of its id) or, when there is none, the client IP (`ip`, keyed hash).
 * - The counter is atomic (`CacheProvider.increment`: Redis INCRBY, the per-site
 *   Durable Object, memory), so exactly one request per key sees `1`. That
 *   request writes the row (`refusal.dedup: 'first'`) at the time of the
 *   refusal, so every window with a refusal has a durable row; nothing waits
 *   for a later flush that might never happen.
 * - Later requests in the window write again only at 10, 100, 1000, …
 *   (`'checkpoint'`, `refusal.count = n`), so rows per key and window are at
 *   most `1 + floor(log10(n))`. Between checkpoints the request is only counted
 *   in the metric. If the window ends without another checkpoint, the last
 *   row's count is a lower bound; the metric has the exact total.
 * - The first row of the next window carries `refusal.previousWindowCount`, the
 *   exact count of the window before (its key lives 2W + 60 s for this read).
 *
 * Failure policy: never drop security evidence. A missing cache, a counter
 * that throws or answers a non-integer (B142: a DO answering `{}`), or a window
 * of 0 writes the row (`'unbounded'`). Only a confirmed non-checkpoint count
 * suppresses a row.
 *
 * Keys must not start with `pv` (the pageview drain takes `LIKE 'pv%'`, B145)
 * and `siteId` must stay colon-segment 2 (Cloudflare routes the counter to that
 * site's Durable Object, `cloudflare/cache.ts` `stub`). They expire by TTL.
 */
import type { CacheProvider } from '@lumibase/runtime';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { aiDecisionRefusalsTotal } from '../routes/metrics';
import { clientHashSecret, hashClientIdentifier } from './client-ip-hash';
import type {
  DecisionAuditContext,
  DecisionAuditRecord,
  DecisionRefusalReason,
} from './decision-governance';
import { readBound } from './decision-provider';
import { principalRefFromAuth } from './effective-capability-service';

export const DECISION_REFUSAL_KEY_PREFIX = 'dra';
export const DEFAULT_DECISION_REFUSAL_WINDOW_SECONDS = 300;

/**
 * Kept here (not imported at runtime from `decision-governance.ts`, which
 * imports this module) and checked against `DECISION_REFUSAL_REASONS` in tests.
 */
const KNOWN_REASONS: ReadonlySet<string> = new Set<DecisionRefusalReason>([
  'publishable_api_key',
  'frontend_session',
  'unclassified_caller',
  'capability_missing',
  'principal_unresolved',
  'principal_site_mismatch',
  'principal_not_found',
  'principal_inactive',
  'principal_not_member',
  'api_key_revoked',
  'api_key_expired',
  'dev_principal_forbidden',
  'principal_denied',
  'other',
]);

export type RefusalSubjectKind = 'ip' | 'user' | 'api_key' | 'dev';

/** Where refusals are counted. Built from trusted middleware only. */
export interface DecisionRefusalStore {
  cache?: CacheProvider;
  /** `c.get('ip')` (`extractClientIp`); held in memory only, never written. */
  clientIp: string | null;
  /** Key of the client identifier hash (`JWT_SECRET`). */
  hashSecret: string | null;
  /** Dedup window in seconds; `0` writes a row for every refusal. */
  windowSeconds: number;
  now?: () => number;
}

/** `metadata.refusal` on an aggregated refusal row. */
export interface DecisionRefusalSummary {
  reason: DecisionRefusalReason;
  /** Refusals in this window so far, this one included (a lower bound for the window). */
  count: number;
  dedup: 'first' | 'checkpoint' | 'unbounded';
  /** ISO start of the window; `null` when the row was not aggregated. */
  windowStart: string | null;
  windowSeconds: number;
  /** Exact refusal count of the previous window, on the first row of a window. */
  previousWindowCount?: number;
}

type RowWriter = (audit: DecisionAuditContext, record: DecisionAuditRecord) => Promise<void>;

export function decisionRefusalWindowSeconds(env: { DECISION_REFUSAL_AUDIT_WINDOW_SECONDS?: string }): number {
  return readBound(
    env.DECISION_REFUSAL_AUDIT_WINDOW_SECONDS,
    DEFAULT_DECISION_REFUSAL_WINDOW_SECONDS,
    0,
    86_400,
    'DECISION_REFUSAL_AUDIT_WINDOW_SECONDS',
  );
}

export function refusalDedupKey(parts: {
  siteId: string;
  window: number;
  kind: RefusalSubjectKind;
  subjectHash: string;
  reason: DecisionRefusalReason;
}): string {
  return `${DECISION_REFUSAL_KEY_PREFIX}:${parts.siteId}:${parts.window}:${parts.kind}:${parts.subjectHash}:${parts.reason}`;
}

/** 10, 100, 1000, … */
export function isRefusalCheckpoint(n: number): boolean {
  if (!Number.isSafeInteger(n) || n < 10) return false;
  let rest = n;
  while (rest % 10 === 0) rest /= 10;
  return rest === 1;
}

function refusalReasonOf(reason: string | undefined): DecisionRefusalReason {
  return reason && KNOWN_REASONS.has(reason) ? (reason as DecisionRefusalReason) : 'other';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

async function hashOrNull(siteId: string, value: string | null, secret: string | null): Promise<string | null> {
  if (!value) return null;
  try {
    return await hashClientIdentifier(siteId, value, secret);
  } catch {
    return null;
  }
}

/**
 * Records one authorization refusal: always the metric, and an audit row when
 * this refusal is the first or a checkpoint of its window, or when the counter
 * cannot be trusted. Never throws (like `AuditLogger.write`).
 */
export async function recordDecisionRefusal(
  audit: DecisionAuditContext,
  record: DecisionAuditRecord,
  writeRow: RowWriter,
): Promise<void> {
  const reason = refusalReasonOf(record.refusalReason);
  const principal = audit.principal;
  const principalLabel = principal?.type ?? 'anonymous';
  const store = audit.refusal;
  const windowSeconds = store?.windowSeconds ?? 0;
  const ip = store?.clientIp && store.clientIp !== 'unknown' ? store.clientIp : null;

  let summary: DecisionRefusalSummary = { reason, count: 1, dedup: 'unbounded', windowStart: null, windowSeconds };
  let disposition: 'written' | 'suppressed' | 'unbounded' = 'unbounded';
  let clientIpHash: string | null = null;
  try {
    clientIpHash = await hashOrNull(audit.siteId, ip, store?.hashSecret ?? null);
    if (store?.cache && windowSeconds > 0) {
      const kind: RefusalSubjectKind = principal?.type ?? 'ip';
      const subject = !principal
        ? clientIpHash ?? 'unknown'
        : await hashClientIdentifier(
            audit.siteId,
            principal.type === 'user' ? principal.userId : principal.type === 'api_key' ? principal.apiKeyId : 'dev',
            store.hashSecret,
          );
      const nowMs = (store.now ?? Date.now)();
      const window = Math.floor(nowMs / (windowSeconds * 1000));
      const ttl = 2 * windowSeconds + 60;
      const key = (w: number) => refusalDedupKey({ siteId: audit.siteId, window: w, kind, subjectHash: subject, reason });
      const n: unknown = await store.cache.increment(key(window), 1, { ttl });
      if (isCount(n)) {
        const windowStart = new Date(window * windowSeconds * 1000).toISOString();
        if (n === 1) {
          summary = { reason, count: 1, dedup: 'first', windowStart, windowSeconds };
          disposition = 'written';
          try {
            const previous: unknown = await store.cache.increment(key(window - 1), 0, { ttl });
            if (isCount(previous)) summary.previousWindowCount = previous;
          } catch {
            // The row is still written; only the carry-over is missing.
          }
        } else if (isRefusalCheckpoint(n)) {
          summary = { reason, count: n, dedup: 'checkpoint', windowStart, windowSeconds };
          disposition = 'written';
        } else {
          disposition = 'suppressed';
        }
      }
    }
  } catch {
    // Counter or hash failure: fall through and write the row unbounded.
    summary = { reason, count: 1, dedup: 'unbounded', windowStart: null, windowSeconds };
    disposition = 'unbounded';
  }

  aiDecisionRefusalsTotal.inc({ reason, principal: principalLabel, audit: disposition });
  if (disposition === 'suppressed') return;
  try {
    await writeRow(audit, { ...record, refusalReason: reason, refusal: summary, clientIpHash });
  } catch (err) {
    console.error('[ai/decisions] refusal audit write failed', err instanceof Error ? err.name : 'unknown');
  }
}

/**
 * The audit context every request-path decision entry point must use
 * (`decision-governance.wiring.test.ts`): it carries the refusal store, so
 * refusals are bounded. Synchronous; hashing happens on the refusal path only.
 */
export function decisionAuditContextForRequest(c: Context<AppEnv>): DecisionAuditContext {
  const siteId = c.get('siteId');
  const env = (c.env ?? {}) as AppEnv['Bindings'];
  return {
    db: c.get('db'),
    siteId,
    requestId: c.get('requestId') ?? null,
    principal: principalRefFromAuth(c.get('auth'), siteId),
    refusal: {
      cache: c.get('runtime')?.cache,
      clientIp: c.get('ip') ?? null,
      hashSecret: clientHashSecret(env),
      windowSeconds: decisionRefusalWindowSeconds(env),
    },
  };
}
