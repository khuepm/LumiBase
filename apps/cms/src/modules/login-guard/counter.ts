/**
 * Sliding-window failure counters for the Login Guard.
 *
 * Counts the number of `result='fail'` rows in `login_attempts` for a
 * given email or client IP within the last `windowSeconds` seconds.
 * The Postgres-backed implementation is the default — Self-hosted
 * Lumibase ships without Redis (design §6.4) and the
 * `(email_lower, created_at)` / `(ip, created_at)` indexes added in
 * task 5.1 make these range scans cheap (≤5ms with <100k rows/hour).
 *
 * Operators who want sub-millisecond counters can opt in to Redis by
 * setting `LUMIBASE_REDIS_URL`; the {@link CounterStore} interface is
 * the seam for that adapter so the LoginGuard call sites stay
 * untouched. A future Phase C+ change will add a `RedisCounterStore`
 * that wraps INCR + EXPIRE around `login_attempts` writes; until then
 * the factory returns the Postgres implementation regardless of env.
 *
 * Validates: Requirements 7.1, 8.1
 *           (Property 12 — Sliding Window Correctness, design §13).
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { loginAttempts, type Database } from '@lumibase/database';

import { normalizeEmail } from './email-normalize';

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Pluggable counter backend. The Postgres implementation reads
 * `login_attempts` directly so writes by the LoginGuard automatically
 * advance the counter; a Redis implementation would sit alongside the
 * insert and bump an INCR + EXPIRE counter so the read path becomes
 * O(1).
 *
 * The interface is intentionally narrow:
 *   - `userFailedCount` keys on the lower-cased email (the same
 *     normalisation used at insert time) so a typoed `Foo@Bar` and
 *     `foo@bar` collide on the same counter.
 *   - `ipFailedCount` keys on the resolved client IP (per
 *     `extractClientIp` in task 5.4: `CF-Connecting-IP` →
 *     `X-Forwarded-For` → socket).
 *   - Both methods accept the rolling window in seconds because
 *     `Lockout_Policy.lockoutWindowSeconds` is operator-configurable
 *     (Req 6.3) and the LoginGuard middleware will pass the policy
 *     value at call time.
 *
 * `windowSeconds` is clamped to ≥ 1 to keep the SQL `interval` literal
 * sensible — a zero or negative value would otherwise return 0 silently
 * and mask a misconfiguration.
 */
export interface CounterStore {
  /**
   * Failed login attempts for a given email in the last
   * `windowSeconds` seconds.
   *
   * @param email Email as supplied by the client. Normalised to lower
   *              case + trimmed before keying so it matches the
   *              `email_lower` column written by the LoginGuard.
   * @param windowSeconds Rolling-window length. Treated as ≥ 1.
   */
  userFailedCount(email: string, windowSeconds: number): Promise<number>;

  /**
   * Failed login attempts from a given IP in the last `windowSeconds`
   * seconds, regardless of email.
   *
   * @param ip Client IP as resolved by `extractClientIp`.
   * @param windowSeconds Rolling-window length. Treated as ≥ 1.
   */
  ipFailedCount(ip: string, windowSeconds: number): Promise<number>;
}

// ── Postgres implementation (default) ───────────────────────────────────

/**
 * Counter backed by the `login_attempts` table.
 *
 * The two queries below are the canonical SQL from design §6.4:
 *
 *   SELECT count(*) FROM login_attempts
 *   WHERE email_lower = $1 AND result = 'fail'
 *     AND created_at >= now() - ($2 || ' seconds')::interval;
 *
 * Drizzle's `count(*)` returns `bigint` over the wire; we cast to `int`
 * inside the SQL fragment so the JS side gets a plain number without
 * a precision conversion. The `(N || ' seconds')::interval` form is
 * used (rather than `make_interval`) because it keeps the parameter
 * binding simple — Postgres concatenates the bound text with the
 * literal `' seconds'` and casts the result. The window is clamped to
 * an integer ≥ 1 in {@link clampWindowSeconds} so we never construct
 * `'-5 seconds'` or fractional intervals.
 */
export class PostgresCounterStore implements CounterStore {
  constructor(private readonly db: Database) {}

  async userFailedCount(email: string, windowSeconds: number): Promise<number> {
    const emailLower = normalizeEmail(email);
    if (emailLower.length === 0) return 0;

    const window = clampWindowSeconds(windowSeconds);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.emailLower, emailLower),
          eq(loginAttempts.result, 'fail'),
          gte(
            loginAttempts.createdAt,
            sql`now() - (${String(window)} || ' seconds')::interval`,
          ),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async ipFailedCount(ip: string, windowSeconds: number): Promise<number> {
    const trimmedIp = (ip ?? '').trim();
    if (trimmedIp.length === 0) return 0;

    const window = clampWindowSeconds(windowSeconds);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.ip, trimmedIp),
          eq(loginAttempts.result, 'fail'),
          gte(
            loginAttempts.createdAt,
            sql`now() - (${String(window)} || ' seconds')::interval`,
          ),
        ),
      );
    return rows[0]?.count ?? 0;
  }
}

// ── Convenience module-level helpers ────────────────────────────────────

/**
 * Functional wrapper around {@link PostgresCounterStore.userFailedCount}.
 *
 * Exposed so LoginGuard call sites that already hold a `Database`
 * handle (e.g. via `c.get('db')`) can call the counter without
 * threading a {@link CounterStore} instance through their constructor.
 * For tests and adapters that need pluggability, prefer constructing a
 * {@link PostgresCounterStore} (or a custom {@link CounterStore}
 * implementation) explicitly.
 */
export function userFailedCount(
  db: Database,
  email: string,
  windowSeconds: number,
): Promise<number> {
  return new PostgresCounterStore(db).userFailedCount(email, windowSeconds);
}

/**
 * Functional wrapper around {@link PostgresCounterStore.ipFailedCount}.
 * See {@link userFailedCount} for usage notes.
 */
export function ipFailedCount(
  db: Database,
  ip: string,
  windowSeconds: number,
): Promise<number> {
  return new PostgresCounterStore(db).ipFailedCount(ip, windowSeconds);
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Operator-supplied environment knobs that affect counter selection.
 *
 * Only `LUMIBASE_REDIS_URL` is consulted today; when set, a future
 * `RedisCounterStore` will replace the Postgres implementation. The
 * field is read here (rather than at module load) so tests can inject
 * a synthetic env without monkey-patching `process.env`.
 */
export interface CounterStoreEnv {
  readonly LUMIBASE_REDIS_URL?: string;
}

/**
 * Build a {@link CounterStore} from a Drizzle handle and the runtime
 * environment.
 *
 * Returns the Postgres-backed implementation today. When
 * `env.LUMIBASE_REDIS_URL` is set, a console warning is emitted so
 * operators upgrading from a future release where Redis is wired
 * notice that the optimisation isn't active yet — but the Postgres
 * counter still works correctly, so we never throw.
 */
export function createCounterStore(
  db: Database,
  env: CounterStoreEnv = {},
): CounterStore {
  if (env.LUMIBASE_REDIS_URL && env.LUMIBASE_REDIS_URL.length > 0) {
    // Phase C+ will wire RedisCounterStore. Until then, surface a
    // single warning so the operator's intent is acknowledged but the
    // request still succeeds against Postgres.
    if (!warnedAboutRedis) {
      warnedAboutRedis = true;
      console.warn(
        '[login-guard] LUMIBASE_REDIS_URL is set but the Redis counter ' +
          'backend is not yet implemented; falling back to the Postgres ' +
          'sliding-window counter. See design.md §6.4.',
      );
    }
  }
  return new PostgresCounterStore(db);
}

let warnedAboutRedis = false;

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Clamp the window to a positive integer number of seconds.
 *
 * `Math.floor` discards fractional seconds — the SQL `interval` cast
 * accepts decimals but the LoginGuard contract is integer seconds and
 * a fractional cushion would surprise an operator reading the policy.
 * Negative or NaN values fall back to 1 so the resulting query window
 * is always non-empty (a zero-length window would silently report 0
 * even when the table has matching rows).
 */
function clampWindowSeconds(input: number): number {
  if (!Number.isFinite(input)) return 1;
  const floored = Math.floor(input);
  return floored >= 1 ? floored : 1;
}
