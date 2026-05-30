/**
 * AuditRotator — retention pruning for the `audit_log` and
 * `login_attempts` tables (admin-setup-wizard task 11.3; Req 15.5;
 * design §10.2).
 *
 * The audit trail and the login-attempts sliding-window log grow
 * monotonically: every security-relevant action appends a row and
 * nothing ever deletes one on the hot path. Left unbounded those two
 * tables would eventually dominate the database and slow the very
 * queries (recent-activity scans, sliding-window failure counts) the
 * indexes were added to keep fast. This module owns the *maintenance*
 * side of that lifecycle — it prunes rows older than a configurable
 * retention horizon so the working set stays bounded.
 *
 * ── What `rotate()` does (design §10.2) ──────────────────────────────────
 *
 * The design pins the rotation to two parameterised DELETEs:
 *
 *   DELETE FROM audit_log       WHERE timestamp  < now() - ($days || ' days')::interval;
 *   DELETE FROM login_attempts  WHERE created_at < now() - ($days || ' days')::interval;
 *
 * `$days` is `LUMIBASE_AUDIT_RETENTION_DAYS` (default 90, valid range
 * 1–3650). Both tables share the same horizon — the schema comment on
 * `login_attempts` already notes "Rows are rotated by the same job that
 * prunes `audit_log`" — so a single `retentionDays` drives both.
 *
 * ── Retention resolution + clamp ({@link resolveRetentionDays}) ──────────
 *
 * The env value is operator-supplied free text, so it is validated, not
 * trusted. {@link resolveRetentionDays} parses it as a base-10 integer
 * and accepts it ONLY when it lands inside the inclusive `[1, 3650]`
 * range. Anything else — `undefined`, empty string, non-numeric
 * (`'abc'`), a float (`'30.5'`), or an out-of-range value (`0`,
 * `5000`) — falls back to the default of 90 days. We deliberately fall
 * back to the *default* on an out-of-range value rather than clamping
 * to the nearest bound: an operator who typed `5000` has made a
 * mistake, and silently pruning at 3650 days (≈10 years) would hide it
 * just as badly as pruning at 5000 would. Falling back to the
 * well-known 90-day default is the least-surprising recovery and is
 * easy to spot in a config review. The helper is exported and pure so
 * the wiring layer (task 11.4) and the tests can share one source of
 * truth for the clamp.
 *
 * The env *read* itself is intentionally NOT baked into the rotation
 * logic. The preferred wiring (task 11.4) resolves `retentionDays`
 * once at startup and passes the resolved integer into the
 * constructor, which keeps `rotate()` free of any ambient global
 * lookup and makes the throttle/clock fully injectable for tests. As a
 * convenience, when no `retentionDays` is supplied the rotator reads
 * `LUMIBASE_AUDIT_RETENTION_DAYS` itself via {@link readRetentionEnv},
 * which defensively probes `globalThis.process?.env` exactly like
 * `path-mask.ts`'s `getLogLevel` — so the rotator never throws on the
 * Cloudflare Workers runtime where `process.env` is absent.
 *
 * ── Best-effort, per-table semantics ─────────────────────────────────────
 *
 * The rotator is a *background maintenance job*, not a request-path
 * operation. A transient failure (a lock timeout, a brief connectivity
 * blip) must not crash the hourly cron or bubble an exception into the
 * audit-context middleware that may trigger it. So {@link
 * AuditRotator.rotate} runs the two DELETEs **independently** and
 * **best-effort**: each table is pruned in its own try/catch, a failure
 * is logged via `console.warn` and swallowed, and the method returns
 * the count of rows that *did* delete. Partial progress is fine — the
 * next hourly run retries whatever didn't complete. This is the same
 * "never let maintenance break the main flow" stance the AuditLogger
 * takes for writes (design §10.1).
 *
 * The deleted-row count is obtained with `DELETE ... RETURNING id`
 * (Postgres supports it; Drizzle exposes it via `.returning(...)`) and
 * summed across both tables. Returning only the `id` column keeps the
 * payload tiny while still giving an exact count that is portable
 * across drivers (we don't depend on a driver-specific `rowCount`).
 *
 * ── Count-trigger + 1/hour throttle ({@link AuditRotator.maybeRotateOnHighCount}) ──
 *
 * Beyond the hourly cron, design §10.2 lets the audit-context
 * middleware trigger a rotation *opportunistically* when the table
 * grows large: "OR triggered when count(*) > 10,000 … (best-effort,
 * throttled 1/h)". {@link AuditRotator.maybeRotateOnHighCount}
 * implements exactly that:
 *
 *   1. `SELECT count(*) FROM audit_log`. If `≤ 10,000`, it is a no-op
 *      (`{ rotated: false }`) — no DELETE is issued.
 *   2. If `> 10,000` AND no rotation has run within the last hour, it
 *      calls {@link AuditRotator.rotate} and returns
 *      `{ rotated: true, deleted }`.
 *   3. Otherwise (a rotation ran < 1h ago) it is throttled to a no-op
 *      (`{ rotated: false }`).
 *
 * The throttle timestamp is **instance state** (not a module-level
 * singleton) so a fresh `AuditRotator` always starts clean and test
 * files never leak throttle state into one another. The flip side,
 * documented here for the wiring layer: the count-trigger throttle is
 * only meaningful if task 11.4 reuses **one** rotator instance across
 * requests — a per-request `new AuditRotator(...)` would reset the
 * throttle on every call and defeat the 1/hour cap. The hourly cron
 * (task 11.4) calls {@link AuditRotator.rotate} directly and is
 * unaffected by this throttle (cron cadence already is the throttle).
 *
 * The "current time" comes from an injectable {@link
 * AuditRotatorDeps.now | now()} clock (default `Date.now`) so the
 * throttle window is testable deterministically without fake timers —
 * the same pattern the notification dispatcher uses.
 *
 * NOTE: this task provides the method only. Wiring it into the
 * audit-context middleware / a request hook, and standing up the
 * hourly cron (node-cron for self-hosted Node, Cloudflare Cron Triggers
 * for Workers), is task 11.4's job and is intentionally NOT done here.
 *
 * ── Why parameterised interval SQL (not string interpolation) ────────────
 *
 * The cutoff uses the same `now() - (${String(retentionDays)} ||
 * ' days')::interval` form the `/unlock-user` handler and the recovery
 * service use for their `' seconds'` windows. `retentionDays` is bound
 * as a parameter and concatenated by Postgres with the literal
 * `' days'` before the `::interval` cast — it is never spliced into the
 * SQL text by JS string concatenation. Even though `retentionDays` is
 * already a clamped integer (so injection is not reachable today),
 * keeping the value parameterised is the project convention and means
 * the SQL stays safe if the resolution ever changes.
 *
 * **Validates: Requirements 15.5**
 *
 * References: requirements §15.5; design.md §10.2.
 */

import { lt, sql } from 'drizzle-orm';
import { auditLog, loginAttempts, type Database } from '@lumibase/database';

// ── retention resolution ──────────────────────────────────────────────────

/** Default retention horizon when the env is unset/invalid (design §10.2). */
export const DEFAULT_RETENTION_DAYS = 90;

/** Inclusive lower bound for a valid `LUMIBASE_AUDIT_RETENTION_DAYS`. */
export const MIN_RETENTION_DAYS = 1;

/** Inclusive upper bound for a valid `LUMIBASE_AUDIT_RETENTION_DAYS`. */
export const MAX_RETENTION_DAYS = 3650;

/** Name of the operator-facing env var that configures retention. */
export const RETENTION_ENV_VAR = 'LUMIBASE_AUDIT_RETENTION_DAYS';

/**
 * Resolve the retention horizon (in days) from a raw env string.
 *
 * Parses `envValue` as a base-10 integer and returns it ONLY when it is
 * a finite integer inside the inclusive `[1, 3650]` range. Every other
 * input — `undefined`, empty/whitespace, non-numeric, a float, or an
 * out-of-range integer — falls back to {@link DEFAULT_RETENTION_DAYS}
 * (90). See the module doc-block for why out-of-range falls back to the
 * default rather than clamping to the nearest bound.
 *
 * Pure + side-effect free so the wiring layer (task 11.4) and the tests
 * can share one definition of the clamp.
 *
 * @param envValue the raw `LUMIBASE_AUDIT_RETENTION_DAYS` string (or
 *   `undefined` when unset).
 */
export function resolveRetentionDays(envValue: string | undefined): number {
  if (typeof envValue !== 'string') return DEFAULT_RETENTION_DAYS;
  const trimmed = envValue.trim();
  if (trimmed.length === 0) return DEFAULT_RETENTION_DAYS;

  // Reject anything that isn't a pure base-10 integer (e.g. '30.5',
  // '0x1e', '1e3', ' 30 ' with internal junk). A strict regex avoids
  // Number()'s permissive coercions (which would accept floats and
  // hex) and parseInt's prefix-parsing (which would accept '30abc').
  if (!/^[+-]?\d+$/.test(trimmed)) return DEFAULT_RETENTION_DAYS;

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed)) return DEFAULT_RETENTION_DAYS;
  if (parsed < MIN_RETENTION_DAYS || parsed > MAX_RETENTION_DAYS) {
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

/**
 * Defensive read of `LUMIBASE_AUDIT_RETENTION_DAYS` from the ambient
 * environment, mirroring `path-mask.ts`'s `getLogLevel`: probes
 * `globalThis.process?.env` inside a try/catch so the rotator never
 * throws on a runtime (Cloudflare Workers) where `process` is absent or
 * throws on access. Returns `undefined` when the var can't be read, in
 * which case {@link resolveRetentionDays} applies the default.
 *
 * Only used as a fallback when the constructor is not given an explicit
 * `retentionDays` — the preferred wiring resolves the value once at
 * startup and passes it in.
 */
function readRetentionEnv(): string | undefined {
  try {
    const proc = (
      globalThis as {
        process?: { env?: Record<string, string | undefined> };
      }
    ).process;
    return proc?.env?.[RETENTION_ENV_VAR];
  } catch {
    return undefined;
  }
}

// ── throttle constants ────────────────────────────────────────────────────

/** Row-count above which {@link AuditRotator.maybeRotateOnHighCount} fires. */
export const HIGH_COUNT_THRESHOLD = 10_000;

/** Minimum spacing between count-triggered rotations: 1 hour (design §10.2). */
export const ROTATE_THROTTLE_MS = 3_600_000;

// ── rotator ────────────────────────────────────────────────────────────────

/** Result of a {@link AuditRotator.rotate} call. */
export interface RotateResult {
  /** Total rows deleted across `audit_log` + `login_attempts`. */
  readonly deleted: number;
}

/** Result of a {@link AuditRotator.maybeRotateOnHighCount} call. */
export interface MaybeRotateResult {
  /** True when a rotation actually ran (count over threshold + not throttled). */
  readonly rotated: boolean;
  /** Rows deleted, present only when {@link MaybeRotateResult.rotated} is true. */
  readonly deleted?: number;
}

export interface AuditRotatorDeps {
  /** Drizzle client used for the DELETEs and the count probe. */
  readonly db: Database;
  /**
   * Pre-resolved retention horizon in days. When supplied it is used
   * verbatim (it is assumed already validated by the wiring layer via
   * {@link resolveRetentionDays}). When omitted, the rotator resolves
   * it once from `LUMIBASE_AUDIT_RETENTION_DAYS` via the defensive
   * {@link readRetentionEnv} + {@link resolveRetentionDays}.
   */
  readonly retentionDays?: number;
  /**
   * Injectable monotonic-ish clock (epoch ms) used for the
   * count-trigger throttle. Defaults to `Date.now`. Tests pass a
   * controllable function so the 1-hour window can be exercised
   * without real waiting or fake timers.
   */
  readonly now?: () => number;
}

/**
 * Prunes `audit_log` and `login_attempts` rows past the retention
 * horizon. See the module doc-block for the best-effort semantics, the
 * count-trigger throttle, and the wiring boundaries (task 11.4).
 */
export class AuditRotator {
  private readonly db: Database;
  private readonly retentionDays: number;
  private readonly now: () => number;

  /**
   * Epoch-ms timestamp of the last rotation triggered through {@link
   * maybeRotateOnHighCount}, or `null` if none has run on this
   * instance. Instance state (not module-level) so a fresh rotator
   * starts un-throttled and tests don't leak state between files.
   */
  private lastRotationAt: number | null = null;

  constructor(deps: AuditRotatorDeps) {
    this.db = deps.db;
    this.retentionDays =
      deps.retentionDays ?? resolveRetentionDays(readRetentionEnv());
    this.now = deps.now ?? (() => Date.now());
  }

  /** The resolved retention horizon in days (for diagnostics / wiring). */
  getRetentionDays(): number {
    return this.retentionDays;
  }

  /**
   * Delete `audit_log` rows older than the retention horizon and
   * `login_attempts` rows older than the same horizon, returning the
   * total number of rows deleted across both tables.
   *
   * Best-effort + per-table: each DELETE runs in its own try/catch so a
   * failure on one table neither aborts the other nor throws out of
   * `rotate()`. A failed table is logged via `console.warn` and counts
   * zero toward the total; the next run retries it. See the module
   * doc-block for the rationale.
   */
  async rotate(): Promise<RotateResult> {
    const auditDeleted = await this.deleteOlderThan(
      'audit_log',
      () =>
        this.db
          .delete(auditLog)
          .where(lt(auditLog.timestamp, this.retentionCutoffSql()))
          .returning({ id: auditLog.id }),
    );

    const attemptsDeleted = await this.deleteOlderThan(
      'login_attempts',
      () =>
        this.db
          .delete(loginAttempts)
          .where(lt(loginAttempts.createdAt, this.retentionCutoffSql()))
          .returning({ id: loginAttempts.id }),
    );

    return { deleted: auditDeleted + attemptsDeleted };
  }

  /**
   * Opportunistic, throttled rotation for the count-trigger path
   * (design §10.2). Reads `count(*)` of `audit_log`; if it exceeds
   * {@link HIGH_COUNT_THRESHOLD} and no rotation has run on this
   * instance within {@link ROTATE_THROTTLE_MS} (1 hour), runs {@link
   * rotate} and returns `{ rotated: true, deleted }`. Otherwise returns
   * `{ rotated: false }` without issuing any DELETE.
   *
   * Like {@link rotate}, this never throws: a failing count probe is
   * logged and treated as "don't rotate" so a transient error in the
   * trigger path can't break the request that invoked it.
   */
  async maybeRotateOnHighCount(): Promise<MaybeRotateResult> {
    // Throttle first — cheaper than the count probe and the common case
    // under load is "we just rotated".
    const nowMs = this.now();
    if (
      this.lastRotationAt !== null &&
      nowMs - this.lastRotationAt < ROTATE_THROTTLE_MS
    ) {
      return { rotated: false };
    }

    let count: number;
    try {
      count = await this.auditLogRowCount();
    } catch (err) {
      console.warn(
        '[audit-rotator] count(*) probe failed; skipping count-triggered ' +
          'rotation this round.',
        err,
      );
      return { rotated: false };
    }

    if (count <= HIGH_COUNT_THRESHOLD) {
      return { rotated: false };
    }

    // Stamp the throttle BEFORE the (best-effort) rotate so a slow or
    // partially-failing rotation can't be re-triggered by a concurrent
    // request inside the same hour.
    this.lastRotationAt = nowMs;
    const { deleted } = await this.rotate();
    return { rotated: true, deleted };
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * The parameterised cutoff expression: rows strictly older than
   * `now() - (retentionDays || ' days')::interval` are eligible for
   * deletion. `retentionDays` is bound as a parameter (never spliced
   * into the SQL text) — see the module doc-block on injection safety.
   */
  private retentionCutoffSql() {
    return sql`now() - (${String(this.retentionDays)} || ' days')::interval`;
  }

  /**
   * Run one table's DELETE best-effort, returning the number of rows it
   * removed (the length of the `RETURNING id` rows) or `0` if it threw.
   */
  private async deleteOlderThan(
    table: string,
    run: () => Promise<Array<{ id: string }>>,
  ): Promise<number> {
    try {
      const rows = await run();
      return rows.length;
    } catch (err) {
      console.warn(
        `[audit-rotator] failed to prune "${table}"; leaving its rows for ` +
          'the next run.',
        err,
      );
      return 0;
    }
  }

  /** `SELECT count(*)::int FROM audit_log`. */
  private async auditLogRowCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLog);
    return rows[0]?.count ?? 0;
  }
}
