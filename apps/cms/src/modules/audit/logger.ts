/**
 * AuditLogger — synchronous, secret-masking, never-throwing writer for
 * the `audit_log` table (admin-setup-wizard task 11.1; Req 15.1, 15.2,
 * 15.3; design §10.1).
 *
 * This module owns the *write path* of the design's `AuditLogger`
 * interface (design §6.3 line ~452). The query/export surface
 * (`GET /admin/security/audit-log{,/export}`) lands in task 12 and the
 * retention rotator in task 11.3 — this file is intentionally scoped to
 * `write()` plus the {@link maskSensitive} helper so it can be
 * unit-tested without Postgres or a Hono context. Event wiring (task
 * 11.2) composes this logger; it does not live here.
 *
 * ── The ≤1s budget (design §10.1) ────────────────────────────────────────
 *
 * Audit writes run synchronously on the request thread, *after* the
 * main business transaction commits (e.g. after a login flow or
 * `/setup/complete`). That keeps the audit row causally consistent with
 * the action it records, but it also means a slow or hung database
 * could stall the request indefinitely. To bound that risk, {@link
 * AuditLogger.write} races the `INSERT` against a {@link
 * AuditLoggerDeps.budgetMs | budget} (default 1000ms). If the insert
 * does not settle within the budget, we stop waiting, emit the
 * structured fallback (below), and resolve — the request thread is
 * freed at the budget deadline regardless of how the DB behaves.
 *
 * Trade-off (documented deliberately): on a budget timeout the
 * underlying insert promise is *not* cancelled — Postgres has no
 * cooperative cancellation here and Drizzle exposes none — so the query
 * may still land in the background after we've already emitted the
 * fallback. We attach a no-op rejection handler to that background
 * promise so a late failure never surfaces as an unhandled rejection,
 * and we accept that a timed-out write can occasionally produce *both*
 * a fallback log line *and* a (late) DB row. Double-recording a rare,
 * slow audit event is strictly safer than dropping it — a log
 * aggregator replay can de-duplicate on `requestId` + `event`.
 *
 * ── Never-throw contract (Req 13.4 spirit) ───────────────────────────────
 *
 * `write()` NEVER throws and NEVER rejects with an error. A failed
 * audit write must not break the business flow it is recording — the
 * login succeeds, the setup completes, the unlock happens, even if the
 * audit row cannot be persisted. Every failure mode — a rejecting
 * insert, a budget timeout, a throwing {@link maskSensitive}, even a
 * throwing {@link AuditLoggerDeps.errorSink | errorSink} — is contained
 * inside `write()` and collapses to a resolved `Promise<void>`. Callers
 * therefore do not need to wrap `write()` in their own try/catch (the
 * `SetupService.complete` post-commit block already relies on this:
 * "a failed audit write must not fail the request", design §6.5).
 *
 * ── The structured fallback (design §10.1) ───────────────────────────────
 *
 * When the DB write fails or times out, we emit a single structured
 * record through {@link AuditLoggerDeps.errorSink | errorSink}:
 *
 *     { level: 'error', source: 'audit-fallback', entry: <masked entry>, reason? }
 *
 * The default sink serialises this to JSON and writes it to
 * `console.error`, so a log aggregator (which scrapes stderr) can
 * *replay* the lost audit event into the trail out-of-band. The shape
 * is pinned by the design; `reason` is an additive hint
 * (`'budget_exceeded' | 'db_error' | 'mask_failed'`) to speed up
 * operator triage and does not change the contract. Crucially, the
 * `entry` carried by the fallback is the SAME masked entry we attempted
 * to insert — never the raw secrets (see below).
 *
 * ── Secret masking ({@link maskSensitive}, Req 15.3) ─────────────────────
 *
 * Req 15.3 forbids writing passwords, password hashes, raw Setup
 * Tokens, raw Backup Codes, or Recovery Tokens to the audit trail.
 * {@link maskSensitive} deep-walks the `metadata` object (the only
 * free-form field on an audit entry — Req 15.2) and rewrites a fixed,
 * well-known set of secret keys BEFORE the insert *and* before the
 * fallback:
 *
 *   - `passwordHash`                       → `null`
 *   - `setupToken` / `backupCode` / `recoveryToken`
 *                                          → `sha256(value).slice(0, 8)`
 *                                            (first 8 hex chars) when the
 *                                            value is a non-empty string;
 *                                            `null` otherwise (defensive)
 *
 * The 8-hex-char SHA-256 prefix is intentional: it is enough to
 * *correlate* two audit entries that reference the same secret (e.g. to
 * see a Setup Token minted and later consumed) without being reversible
 * back to the secret itself. Every OTHER key is left untouched and the
 * walk recurses into nested objects and arrays, so a secret buried in
 * `metadata.context.setupToken` or `metadata.codes[0].backupCode` is
 * still masked. Key matching is exact and case-sensitive — these are
 * internal field names we control (the same spellings used across
 * `SetupService`, the Recovery Service, and the Login Guard), so a
 * loose match would risk masking unrelated keys. The mask is a pure,
 * non-mutating clone (the caller's `metadata` object is never altered).
 *
 * Because the masking hashes secrets with Web Crypto's async
 * `crypto.subtle.digest` (runtime-portable across Node 20+ and
 * Cloudflare Workers — the same approach as
 * `apps/cms/src/modules/setup/setup-token.ts` and
 * `apps/cms/src/modules/recovery/service.ts`), {@link maskSensitive} is
 * itself `async` and returns a `Promise`. `write()` awaits it.
 *
 * ── Relationship to `path-mask.ts` (task 4.5) ────────────────────────────
 *
 * {@link maskSensitive} is the SECRET-masking complement to
 * {@link ../audit/path-mask | maskAdminPath}. `path-mask.ts` masks one
 * thing — the configured Admin_Path — out of arbitrary log strings and
 * metadata (Req 5.5). This module masks the four secret KEYS above out
 * of audit `metadata` (Req 15.3). They are deliberately separate: a
 * caller that needs both (e.g. an audit entry whose metadata mentions
 * the admin path *and* carries a setup token) can compose them —
 * `maskAdminPath(await maskSensitive(metadata), adminPath)` — but
 * neither helper does the other's job.
 *
 * **Validates: Requirements 15.1, 15.2, 15.3**
 *
 * References: requirements §15.1–15.3; design.md §10.1, §6.3.
 */

import { auditLog, type Database } from '@lumibase/database';

// ── audit event vocabulary (Req 15.1) ────────────────────────────────────

/**
 * The 15 audit event codes enumerated in Req 15.1.
 *
 * `audit_log.event` is stored as plain text (not a Postgres enum) so
 * new codes can be added without a migration — see the schema comment
 * in `packages/database/src/schema/security.ts`. We surface the known
 * set here purely as documentation + editor autocomplete for callers
 * (the task 11.2 wiring writes exactly these). {@link AuditEvent}
 * widens to accept any string via the `(string & {})` idiom so the
 * union does not *constrain* the column — forward-compatible by design.
 */
export const AUDIT_EVENTS = [
  'setup_started',
  'setup_completed',
  'bootstrap_admin_created',
  'admin_path_set',
  'lockout_policy_updated',
  'login_success',
  'login_failed',
  'user_locked',
  'user_unlocked',
  'ip_blocked',
  'ip_unblocked',
  'anomaly_triggered',
  'recovery_initiated',
  'recovery_completed',
  'backup_code_used',
] as const;

/** One of the 15 Req 15.1 codes. */
export type AuditEventCode = (typeof AUDIT_EVENTS)[number];

/**
 * An audit event code. The `(string & {})` member keeps literal
 * autocomplete for the 15 known {@link AuditEventCode}s while still
 * accepting arbitrary strings, matching the free-text storage contract
 * (so new codes don't require a type change).
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type AuditEvent = AuditEventCode | (string & {});

// ── entry shapes ──────────────────────────────────────────────────────────

/**
 * A fully-materialised audit log row, mirroring the `audit_log` table
 * columns (design §3.6 / `packages/database/src/schema/security.ts`).
 *
 * `id` and `timestamp` are assigned by the database (`nanoid` default
 * and `defaultNow()` respectively), so callers never supply them — see
 * {@link AuditLogWriteInput}.
 */
export interface AuditLogEntry {
  /** `nanoid` primary key, assigned by the DB default. */
  readonly id: string;
  /** Insert time, assigned by the DB `defaultNow()`. */
  readonly timestamp: Date;
  /** One of the Req 15.1 event codes (stored as text). */
  readonly event: AuditEvent;
  /** Email of the actor performing the action; null when unauthenticated. */
  readonly actorEmail?: string | null;
  /** Email the action targets (e.g. unlock-user); null when N/A. */
  readonly targetEmail?: string | null;
  /** Client IP (per `extractClientIp`); null when unavailable. */
  readonly ip?: string | null;
  /** Raw User-Agent header; null when absent. */
  readonly userAgent?: string | null;
  /** ISO-3166 alpha-2 country code; null when GeoIP unavailable. */
  readonly countryCode?: string | null;
  /**
   * Event-specific payload (≤4KB serialized). Secrets are masked by
   * {@link maskSensitive} before write — see the module doc-block.
   */
  readonly metadata?: Record<string, unknown>;
  /** Correlates with the request-id middleware header. */
  readonly requestId?: string | null;
}

/**
 * The input accepted by {@link AuditLogger.write}: an {@link
 * AuditLogEntry} minus the DB-assigned `id` and `timestamp`. Matches
 * the design interface `write(entry: Omit<AuditLogEntry,'id'|'timestamp'>)`
 * and is shape-compatible with the `AuditWriter` entry already used by
 * `SetupService` (`apps/cms/src/modules/setup/service.ts`).
 */
export type AuditLogWriteInput = Omit<AuditLogEntry, 'id' | 'timestamp'>;

/**
 * The structured record emitted to {@link AuditLoggerDeps.errorSink}
 * when a DB write fails or exceeds its budget. The `level` / `source` /
 * `entry` triple is pinned by design §10.1 so a log aggregator can
 * recognise and replay it; `entry` always carries the MASKED entry
 * (never raw secrets). `reason` is an additive triage hint.
 */
export interface AuditFallbackRecord {
  readonly level: 'error';
  readonly source: 'audit-fallback';
  /** The masked entry we attempted to persist (secrets already removed). */
  readonly entry: AuditLogWriteInput;
  /** Why the primary write failed: budget timeout vs DB error vs mask error. */
  readonly reason?: 'budget_exceeded' | 'db_error' | 'mask_failed';
}

// ── masking ────────────────────────────────────────────────────────────────

/**
 * Keys whose value is unconditionally replaced with `null`. A password
 * hash has no correlation value in an audit trail and must never be
 * stored (Req 3.7, 15.3), so we drop it entirely rather than hashing it.
 */
const SENSITIVE_NULL_KEYS = new Set<string>(['passwordHash']);

/**
 * Keys whose string value is replaced with the first 8 hex chars of its
 * SHA-256 (Req 15.3). These are single-use secrets where a short,
 * non-reversible prefix is enough to correlate "minted" with "consumed"
 * audit entries without ever exposing the secret.
 */
const SENSITIVE_HASH_KEYS = new Set<string>([
  'setupToken',
  'backupCode',
  'recoveryToken',
]);

const textEncoder = new TextEncoder();

/** Hex-encode bytes (lowercase). */
function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * `sha256(input)` as a lowercase hex string via Web Crypto —
 * runtime-portable across Node 20+ and Cloudflare Workers, matching the
 * approach in `setup-token.ts` / `recovery/service.ts`.
 */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(input),
  );
  return toHex(new Uint8Array(digest));
}

/**
 * Type-guard for the "JSON-object" shape we recurse into. Mirrors
 * `path-mask.ts`'s `isPlainObject`: excludes `null`, arrays, and class
 * instances (anything with a non-`Object` prototype). Audit metadata is
 * always plain JSON-shaped data (Req 15.2), so walking class instances
 * would be both unnecessary and fragile.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Mask a value found under a {@link SENSITIVE_HASH_KEYS} key: a
 * non-empty string becomes its 8-char SHA-256 prefix; anything else
 * (number, object, empty string, null, undefined) becomes `null`
 * defensively — we never want a non-string secret to slip through
 * un-masked.
 */
async function maskSecretValue(value: unknown): Promise<string | null> {
  if (typeof value === 'string' && value.length > 0) {
    return (await sha256Hex(value)).slice(0, 8);
  }
  return null;
}

/**
 * Recursively mask a single value. Arrays and plain objects are walked
 * (key rules applied per-object via {@link maskObject}); every other
 * value is returned as-is. Always allocates fresh containers so the
 * input is never mutated.
 */
async function maskValue(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await maskValue(item));
    }
    return out;
  }
  if (isPlainObject(value)) {
    return maskObject(value);
  }
  return value;
}

/**
 * Mask every entry of a plain object, applying the key rules:
 *   - {@link SENSITIVE_NULL_KEYS} → `null`
 *   - {@link SENSITIVE_HASH_KEYS} → 8-char SHA-256 prefix (or `null`)
 *   - everything else            → recurse via {@link maskValue}
 *
 * Returns a new object — the input is never mutated.
 */
async function maskObject(
  obj: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (SENSITIVE_NULL_KEYS.has(key)) {
      out[key] = null;
    } else if (SENSITIVE_HASH_KEYS.has(key)) {
      out[key] = await maskSecretValue(value);
    } else {
      out[key] = await maskValue(value);
    }
  }
  return out;
}

/**
 * Deep-mask the four secret keys (`passwordHash`, `setupToken`,
 * `backupCode`, `recoveryToken`) out of an audit-metadata object
 * (Req 15.3). See the module doc-block for the full key-set rationale.
 *
 * Behaviour:
 *   - `passwordHash` → `null` (dropped — no correlation value).
 *   - `setupToken` / `backupCode` / `recoveryToken` → first 8 hex chars
 *     of `sha256(String(value))` when the value is a non-empty string;
 *     `null` otherwise (defensive).
 *   - all other keys are left untouched, recursing into nested objects
 *     and arrays so deeply-buried secrets are still masked.
 *
 * Pure + non-mutating: returns a fresh clone; the input is never
 * altered. `async` because the SHA-256 uses Web Crypto's async
 * `crypto.subtle.digest`.
 *
 * Exported standalone (not just as a method) so it is independently
 * unit-testable and reusable; {@link AuditLogger.maskSensitive}
 * delegates to it.
 *
 * @param metadata the audit entry's `metadata` (a plain JSON object).
 *   A non-object input (e.g. `undefined`) is returned as an empty
 *   object so callers can pass `entry.metadata` directly.
 */
export async function maskSensitive(
  metadata: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown>> {
  if (!isPlainObject(metadata)) return {};
  return maskObject(metadata);
}

// ── logger ───────────────────────────────────────────────────────────────

/** Default ≤1s synchronous-write budget (design §10.1). */
const DEFAULT_BUDGET_MS = 1000;

/**
 * Internal sentinel thrown when the insert exceeds {@link
 * AuditLoggerDeps.budgetMs}. Never escapes `write()`.
 */
class AuditBudgetExceededError extends Error {
  constructor(public readonly budgetMs: number) {
    super(`audit write exceeded ${budgetMs}ms budget`);
    this.name = 'AuditBudgetExceededError';
  }
}

export interface AuditLoggerDeps {
  /** Drizzle client used for the `INSERT INTO audit_log`. */
  readonly db: Database;
  /**
   * Sink for the structured fallback record when a write fails or times
   * out. Defaults to a `console.error(JSON.stringify(record))` so a log
   * aggregator scraping stderr can replay the lost event. Injectable so
   * tests can capture the record without touching the console — the
   * clean testable seam for the fallback path.
   */
  readonly errorSink?: (record: AuditFallbackRecord) => void;
  /**
   * Synchronous-write budget in milliseconds. The insert is raced
   * against this deadline; on timeout we emit the fallback and resolve
   * so a slow/hung DB cannot stall the request thread. Defaults to
   * {@link DEFAULT_BUDGET_MS} (1000ms). Injectable so tests can drive
   * the timeout path with a tiny budget.
   */
  readonly budgetMs?: number;
}

/** Default fallback sink: structured JSON on stderr for aggregator replay. */
function defaultErrorSink(record: AuditFallbackRecord): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify(record));
}

/**
 * Synchronous, secret-masking, never-throwing writer for `audit_log`.
 * See the module doc-block for the budget, never-throw, fallback, and
 * masking contracts.
 */
export class AuditLogger {
  private readonly db: Database;
  private readonly errorSink: (record: AuditFallbackRecord) => void;
  private readonly budgetMs: number;

  constructor(deps: AuditLoggerDeps) {
    this.db = deps.db;
    this.errorSink = deps.errorSink ?? defaultErrorSink;
    this.budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  }

  /**
   * Persist an audit entry. Masks the metadata, then races the
   * `INSERT` against the configured budget. NEVER throws or rejects: a
   * rejecting insert, a budget timeout, a throwing mask, or a throwing
   * `errorSink` all collapse to a resolved `Promise<void>` after
   * (best-effort) emitting the structured fallback. See the module
   * doc-block for the full contract.
   */
  async write(entry: AuditLogWriteInput): Promise<void> {
    // 1. Mask secrets BEFORE anything touches the DB or the fallback.
    //    Masking should never throw, but if it somehow does we drop the
    //    metadata wholesale rather than risk leaking raw secrets.
    let masked: AuditLogWriteInput;
    try {
      const maskedMetadata = await maskSensitive(entry.metadata);
      masked = { ...entry, metadata: maskedMetadata };
    } catch {
      masked = { ...entry, metadata: {} };
      this.emitFallback(masked, 'mask_failed');
      return;
    }

    // 2. Insert within budget; on any failure, emit the fallback.
    try {
      await this.insertWithinBudget(masked);
    } catch (err) {
      this.emitFallback(
        masked,
        err instanceof AuditBudgetExceededError
          ? 'budget_exceeded'
          : 'db_error',
      );
    }
  }

  /**
   * Mask the four secret keys out of a metadata object. Instance-method
   * passthrough to the standalone {@link maskSensitive} so callers
   * holding a logger can reuse the masker without a separate import.
   */
  maskSensitive(
    metadata: Record<string, unknown> | null | undefined,
  ): Promise<Record<string, unknown>> {
    return maskSensitive(metadata);
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Run the insert, racing it against the budget timer. Rejects with
   * {@link AuditBudgetExceededError} if the budget elapses first; in
   * that case the underlying insert keeps running in the background
   * with a no-op rejection handler attached (see the budget trade-off
   * in the module doc-block).
   */
  private async insertWithinBudget(entry: AuditLogWriteInput): Promise<void> {
    const insertPromise = this.runInsert(entry);
    // Swallow a late background rejection so a post-budget DB failure
    // never surfaces as an unhandled rejection. This handler is in
    // addition to the one Promise.race attaches, so the race still sees
    // the rejection if the insert loses the race.
    insertPromise.catch(() => {
      /* settled (or failed) in the background after the budget */
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AuditBudgetExceededError(this.budgetMs)),
        this.budgetMs,
      );
      // Don't let the budget timer keep a Node process alive on its own.
      (timer as { unref?: () => void }).unref?.();
    });

    try {
      await Promise.race([insertPromise, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The bare `INSERT INTO audit_log` with the masked entry's columns. */
  private async runInsert(entry: AuditLogWriteInput): Promise<void> {
    await this.db.insert(auditLog).values({
      event: entry.event,
      actorEmail: entry.actorEmail ?? null,
      targetEmail: entry.targetEmail ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      countryCode: entry.countryCode ?? null,
      metadata: entry.metadata ?? {},
      requestId: entry.requestId ?? null,
    });
  }

  /**
   * Emit the structured fallback through {@link errorSink}, swallowing
   * any error the sink itself throws — belt-and-brace so `write()`'s
   * never-throw contract holds even when the fallback path is broken.
   */
  private emitFallback(
    entry: AuditLogWriteInput,
    reason: AuditFallbackRecord['reason'],
  ): void {
    try {
      this.errorSink({
        level: 'error',
        source: 'audit-fallback',
        entry,
        reason,
      });
    } catch {
      /* even a broken sink must not break the business flow */
    }
  }
}
