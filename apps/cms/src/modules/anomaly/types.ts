/**
 * Shared types for the Anomaly Detection subsystem (admin-setup-wizard
 * Phase D — task 7.2 / Req 9, 10, 11, 12; design §8).
 *
 * The {@link AnomalyDetector} interface in design §6.3 is realised as
 * three independent subscore modules — `geo`, `time`, `device` — plus
 * an aggregator. Each subscore returns the same shape so the
 * aggregator can call them uniformly and compute
 * `score = max(g.value, t.value, d.value)` per Req 12.1.
 *
 * `LoginAttemptDraft` is a writable view of the subset of
 * `loginAttempts` columns the detectors mutate while running. The
 * geo detector populates `countryCode` and `geoLookupStatus` so the
 * caller — `LoginGuard.onSuccess` — can persist a single
 * `INSERT INTO login_attempts` with all five anomaly columns
 * (`countryCode`, `geoLookupStatus`, `anomalyScore`,
 * `anomalyTriggered`, `baselineWarmup`) without re-deriving anything
 * the detectors already computed (design §3.4).
 *
 * Validates: shared types only — no runtime behaviour. Each
 * subscore module owns its own validation (Req 9, 10, 11).
 */

/**
 * Outcome of a GeoIP lookup attempt for a given login attempt. Stored
 * verbatim into `login_attempts.geo_lookup_status` per design §3.4.
 *
 *   - `'ok'` — lookup succeeded; `LoginAttemptDraft.countryCode` holds
 *     the resolved ISO-3166 alpha-2 country code.
 *   - `'unavailable'` — lookup was skipped (private/loopback IP, MMDB
 *     file missing, or maxmind package not installed). Caller should
 *     treat the attempt as having no country signal (Req 9.5).
 *   - `'timeout'` — lookup wrapper exceeded the 2 second budget
 *     (Req 9.1). External-service variants (ip-api.com etc.) are the
 *     primary use case; in-process MMDB lookups are sub-millisecond
 *     and effectively never time out.
 */
export type GeoLookupStatus = 'ok' | 'unavailable' | 'timeout';

/**
 * Result of a single subscore (geo / time / device). The `value` is
 * intentionally bounded to `0 | 1` — Req 9.2 / 10.2 / 11.2 emit `1.0`
 * when the signal trips and `0.0` otherwise; the aggregator then
 * formats the max-of-three to 2 decimals (Req 12.1, Property 9).
 *
 * `baselineWarmup` is OR-folded across the three detectors so a user
 * still in warmup on *any* axis bypasses the threshold-action dispatch
 * (Req 12.5). The geo detector flips it `true` when
 * `successfulLogins < 3` per Req 9.4.
 */
export interface Subscore {
  readonly value: 0 | 1;
  readonly baselineWarmup: boolean;
}

/**
 * Mutable subset of the `login_attempts` insert payload that the
 * anomaly detectors fill in while running.
 *
 * The detectors deliberately *don't* hold a reference to the full
 * `loginAttempts.$inferInsert` row because:
 *
 *   - It contains DB-generated columns (`id`, `createdAt`) that the
 *     detector has no business setting.
 *   - It contains columns owned by other detectors / hooks — keeping
 *     the surface narrow makes it obvious which fields each module
 *     writes.
 *
 * Each detector mutates only the fields documented in its module
 * comment; the caller (LoginGuard.onSuccess) is then responsible for
 * the actual `INSERT`. Tests can pass a plain object literal and
 * assert on the post-call shape.
 */
export interface LoginAttemptDraft {
  /** ISO-3166 alpha-2 country code; populated by `geoSubscore` on success. */
  countryCode?: string | null;
  /** Outcome of the GeoIP lookup; populated by `geoSubscore` always. */
  geoLookupStatus?: GeoLookupStatus | null;
}

/**
 * Snapshot of the per-user behavioural baseline that the geo
 * subscore reads (`login_baselines` row from design §3.5). Only the
 * fields the geo subscore actually consults are typed here so unit
 * tests can stub the loader with a minimal object.
 *
 * `null` from the baseline loader means "row not yet inserted" — the
 * detector treats this identically to `successfulLogins=0` and an
 * empty country list, which falls into the warmup branch (Req 9.4).
 */
export interface GeoBaselineSnapshot {
  /** ISO-3166 alpha-2 country codes seen on prior successful logins. */
  readonly countries: readonly string[];
  /** Total successful logins; gates warmup mode at `< 3` (Req 9.4). */
  readonly successfulLogins: number;
}
