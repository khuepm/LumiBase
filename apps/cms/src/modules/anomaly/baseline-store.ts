/**
 * Baseline writer for the Anomaly Detector (admin-setup-wizard
 * task 7.5; Req 9.6, 10.5, 11.5, 11.6; design §3.5, §8.1, §8.2, §8.3).
 *
 * `updateBaseline(db, userId, attempt, now?)` mutates the per-user
 * `login_baselines` row to fold in the signals from a single
 * successful login attempt. It is the *write* counterpart to the
 * three readers in this module — `geo.ts`, `time.ts`, `device.ts` —
 * which read the same row to compute their subscores. Keeping read
 * and write split is intentional: each subscore must score the
 * *current* attempt against the baseline that existed *before* the
 * attempt, then this writer folds the attempt in *after* the score
 * is recorded (design §8.2 / §8.3 — "atomic update inside the same
 * transaction as `LoginGuard.onSuccess`"). Reversing the order would
 * mean a brand-new device fingerprint is "known" the instant it's
 * scored, defeating the detector entirely.
 *
 * Invariants maintained on the row:
 *
 *   - `successful_logins` is monotonically incremented by 1 per call
 *     (Req 9.4 / 10.4 / 11.4 — the three warmup gates all read it).
 *   - `countries` is a deduplicated list of ISO-3166 alpha-2 codes,
 *     capped at {@link COUNTRIES_CAP} entries (Req 9.6; design §8.1).
 *     New entries append to the *end*; when the cap is hit, the
 *     oldest entry at the front is dropped to make room. This FIFO
 *     eviction is a deliberate choice over LRU: a user's country set
 *     should reflect their long-term geography (home + travel +
 *     migration), so "least recently seen" is less appropriate than
 *     "first seen" when we have to drop.
 *   - `hour_histogram` is a 24-entry array (one bucket per UTC hour,
 *     Req 10.5; design §8.2). The bucket at `now.getUTCHours()` is
 *     incremented by 1; all other buckets are preserved. Length is
 *     normalised to 24 even when the stored row has drifted (a
 *     defensive guard around historical data fixes — see comment on
 *     {@link normaliseHistogram}).
 *   - `device_fingerprints` is an MRU-ordered LRU of
 *     `{ fp, lastSeenAt }` entries, capped at {@link
 *     DEVICE_FINGERPRINT_LRU_CAP} (Req 11.5, 11.6; design §8.3).
 *     The new fingerprint is prepended to the front; any existing
 *     entry with the same `fp` is removed before the prepend so the
 *     fingerprint shows up exactly once with its updated
 *     `lastSeenAt`. When the list exceeds the cap, entries are
 *     dropped from the back (oldest `lastSeenAt`).
 *   - `updatedAt` is bumped to `now`.
 *
 * Skip rules (per task 7.5 spec line):
 *
 *   - `attempt.countryCode` empty / null → don't touch `countries`.
 *     The geo subscore tagged the lookup `'unavailable'` or
 *     `'timeout'`; folding `null` into the country set would create a
 *     phantom "user has logged in from no-country-known", which the
 *     geo detector then can't compare against on subsequent attempts.
 *   - `attempt.deviceFingerprint` empty / null → don't touch
 *     `device_fingerprints`. The device subscore tagged the lookup
 *     `'unavailable'` (missing UA); seeding the LRU with an empty
 *     fingerprint would let any subsequent missing-UA attempt match
 *     the baseline trivially.
 *   - `successful_logins` and `hour_histogram` are *always* updated.
 *     They don't depend on optional inputs — even a login from an
 *     unknown country with a missing UA still happened at a specific
 *     UTC hour and counts toward the warmup gates.
 *
 * Concurrency model:
 *
 *   The function expects to run inside a transaction owned by its
 *   caller — typically `LoginGuard.onSuccess` (task 8.1). Sequence:
 *
 *     1. `INSERT INTO login_baselines (user_id) VALUES ($1)
 *        ON CONFLICT (user_id) DO NOTHING`
 *
 *        Idempotently ensures the row exists. The defaults baked
 *        into the schema (`countries=[]`, `hour_histogram=Array(24)
 *        .fill(0)`, `device_fingerprints=[]`, `successful_logins=0`)
 *        make the freshly-inserted row immediately mergeable.
 *
 *     2. `SELECT ... FOR UPDATE` on the same row.
 *
 *        Takes a row-level lock so two concurrent successful logins
 *        for the same user serialise on the merge — the second
 *        waiter sees the first's increment, so we never lose a
 *        bucket count. Without `FOR UPDATE`, two concurrent reads
 *        would both observe `successful_logins=N`, both compute
 *        `N+1`, and the last UPDATE would clobber the first
 *        (lost-update on read-merge-write).
 *
 *     3. Merge in JS — compute the new `countries`, `hour_histogram`,
 *        `device_fingerprints`, `successful_logins`.
 *
 *     4. `UPDATE login_baselines SET ... WHERE user_id = $1`.
 *
 *   Step 2 + 3 + 4 must run inside the same transaction as the
 *   `INSERT INTO login_attempts` from `recordLoginSuccess` so a
 *   transaction rollback (e.g. an audit-log write fails) reverts
 *   *both* the attempt row and the baseline mutation. Calling this
 *   function on a bare `Database` handle is a programming error —
 *   the SELECT/UPDATE pair would each run in its own implicit
 *   transaction and the lock would be released between them — but
 *   the function still works as a best-effort write because the
 *   surface uses the same Drizzle query API (the docstring above is
 *   the contract; the runtime only requires "anything that quacks
 *   like a Drizzle handle").
 *
 * Design vs. spec note (`jsonb_set` vs read-merge-write):
 *
 *   The original task line called for `jsonb_set` so the entire
 *   merge happens in a single SQL statement. We deliberately use
 *   read-merge-write because:
 *
 *     - The country dedup + cap and the device LRU eviction can't be
 *       expressed in a single `jsonb_set` call — they need
 *       array-level set-membership tests and slice operations that
 *       only become tractable in `plpgsql` or with multiple
 *       statements anyway, at which point the simplicity of "lock
 *       the row, merge in JS" wins.
 *     - The histogram increment alone *could* be `jsonb_set`, but
 *       splitting it from the other two updates would mean three
 *       round-trips (or a CTE) when one suffices.
 *     - With a `FOR UPDATE` lock, read-merge-write inside the
 *       caller's transaction is functionally atomic at the row
 *       level. Postgres serialises waiting writers on the same row,
 *       so the lost-update window doesn't exist.
 *
 *   The task spec note explicitly endorses this trade-off:
 *   "Use the simpler read-merge-write inside the same transaction,
 *    with `SELECT ... FOR UPDATE` to take the row lock before
 *    merging."
 *
 * Validates: Requirements 9.6, 10.5, 11.5, 11.6.
 */

import { eq } from 'drizzle-orm';
import { loginBaselines, type Database } from '@lumibase/database';

import type { DeviceFingerprintEntry, LoginAttemptDraft } from './types';

// ── Public constants ────────────────────────────────────────────────────

/** Maximum distinct ISO-3166 country codes per user (Req 9.6; design §8.1). */
export const COUNTRIES_CAP = 50;

/** Maximum device-fingerprint LRU entries per user (Req 11.5; design §8.3). */
export const DEVICE_FINGERPRINT_LRU_CAP = 20;

/** Number of UTC-hour buckets in `hour_histogram` (design §3.5, §8.2). */
export const HOUR_HISTOGRAM_LENGTH = 24;

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Update the per-user `login_baselines` row to reflect a single
 * successful login attempt.
 *
 * @param db      Drizzle handle. **Must** be a transaction handle in
 *                production so the SELECT/UPDATE pair runs under a
 *                single row lock alongside the caller's
 *                `recordLoginSuccess` insert. Tests pass a fake
 *                implementing the same query interface.
 * @param userId  Authoritative user id (caller has just verified the
 *                password against this exact row).
 * @param attempt The same {@link LoginAttemptDraft} the geo / device
 *                subscores filled in earlier in the request lifecycle.
 *                Only `countryCode` and `deviceFingerprint` are read;
 *                empty/missing values cause that field's update to be
 *                skipped (see "Skip rules" in the module docstring).
 * @param now     UTC clock for the histogram bucket and the
 *                `lastSeenAt` field on the device LRU. Defaults to
 *                `new Date()`. Tests pin this for determinism.
 */
export async function updateBaseline(
  db: Database,
  userId: string,
  attempt: LoginAttemptDraft,
  now: Date = new Date(),
): Promise<void> {
  // 1. Idempotently ensure the row exists. The schema defaults make
  //    a freshly-inserted row immediately mergeable below.
  await db
    .insert(loginBaselines)
    .values({ userId })
    .onConflictDoNothing();

  // 2. SELECT ... FOR UPDATE to take the row lock and read current
  //    state. `.for('update')` is the Drizzle equivalent of the raw
  //    `FOR UPDATE` clause.
  const rows = await db
    .select({
      countries: loginBaselines.countries,
      hourHistogram: loginBaselines.hourHistogram,
      deviceFingerprints: loginBaselines.deviceFingerprints,
      successfulLogins: loginBaselines.successfulLogins,
    })
    .from(loginBaselines)
    .where(eq(loginBaselines.userId, userId))
    .limit(1)
    .for('update');

  // The INSERT above guarantees a row exists; this guard is purely
  // defensive against a concurrent DELETE (e.g. a user-deletion
  // racing with a login). Bail without an update — the next login
  // will reinsert through step 1 above.
  const row = rows[0];
  if (!row) return;

  // 3. Merge in JS. The helpers below own the cap / dedup / LRU
  //    invariants documented at the top of the file.
  const currentCountries = parseCountries(row.countries);
  const currentHistogram = normaliseHistogram(row.hourHistogram);
  const currentDevices = parseFingerprintList(row.deviceFingerprints);
  const currentLogins = Number.isInteger(row.successfulLogins)
    ? (row.successfulLogins as number)
    : 0;

  const nextCountries = mergeCountry(currentCountries, attempt.countryCode);
  const nextHistogram = bumpHistogramBucket(currentHistogram, now);
  const nextDevices = mergeDevice(
    currentDevices,
    attempt.deviceFingerprint,
    now,
  );
  const nextLogins = currentLogins + 1;

  // 4. Single UPDATE statement carrying all four field updates plus
  //    the `updatedAt` bump. Drizzle's `.update().set()` builds the
  //    correct parameterised SQL; jsonb columns accept arrays /
  //    objects directly via the postgres-js driver.
  await db
    .update(loginBaselines)
    .set({
      countries: nextCountries,
      hourHistogram: nextHistogram,
      deviceFingerprints: nextDevices,
      successfulLogins: nextLogins,
      updatedAt: now,
    })
    .where(eq(loginBaselines.userId, userId));
}

// ── Pure merge helpers (exported for unit tests) ────────────────────────

/**
 * Merge an attempt's country code into the user's known-country list.
 *
 *   - Empty / missing input → return the list unchanged. Skipping
 *     here keeps the "GeoIP unavailable" branch from polluting the
 *     baseline (see "Skip rules" in the module docstring).
 *   - Already present → return the list unchanged. Order is
 *     preserved so the FIFO eviction below stays meaningful.
 *   - Not present → append. If the list is at {@link COUNTRIES_CAP},
 *     drop the oldest entry at the front to make room. FIFO over
 *     LRU is intentional — countries shouldn't churn off the list
 *     just because a user took a long break from a baseline
 *     country.
 *
 *   The country code is normalised to uppercase before comparison
 *   to match how the geo detector emits it (`extractIsoCountry`
 *   uppercases). A lower-case input from a stub or a test fixture
 *   still folds onto the same bucket as the production value.
 */
export function mergeCountry(
  countries: readonly string[],
  countryCode: string | null | undefined,
): string[] {
  if (typeof countryCode !== 'string') return [...countries];
  const normalised = countryCode.trim().toUpperCase();
  if (normalised.length === 0) return [...countries];
  if (countries.includes(normalised)) return [...countries];
  const next = [...countries, normalised];
  if (next.length > COUNTRIES_CAP) {
    return next.slice(next.length - COUNTRIES_CAP);
  }
  return next;
}

/**
 * Increment the bucket at `now.getUTCHours()` in a 24-entry
 * histogram. The result is always length 24 even when the input
 * has drifted (defensive — see {@link normaliseHistogram}).
 *
 * `now` outside the range `[0, 23]` is impossible from
 * `getUTCHours()`, but we clamp defensively so a callsite that
 * accidentally passes a bare `number` (e.g. through a mock) doesn't
 * write past the array bounds.
 */
export function bumpHistogramBucket(
  histogram: readonly number[],
  now: Date,
): number[] {
  const next = normaliseHistogram(histogram);
  const hour = now.getUTCHours();
  if (hour >= 0 && hour < HOUR_HISTOGRAM_LENGTH) {
    next[hour] = (next[hour] ?? 0) + 1;
  }
  return next;
}

/**
 * Merge a fingerprint into the user's device LRU.
 *
 *   - Empty / missing input → return the list unchanged. Skipping
 *     here keeps the "UA missing" branch from seeding the LRU with
 *     an empty-string fingerprint (see "Skip rules" above).
 *   - Existing entry with the same `fp` → drop it; we rebuild with
 *     a fresh `lastSeenAt` at the front. Move-to-front gives the
 *     LRU semantics promised in design §8.3.
 *   - Prepend the new entry to the front (MRU position).
 *   - If the list now exceeds {@link DEVICE_FINGERPRINT_LRU_CAP},
 *     drop entries from the back (LRU position).
 *
 * Returned entries are plain objects (not the readonly type) so the
 * Drizzle insert's runtime `JSON.stringify` doesn't try to enumerate
 * a non-enumerable `Symbol(...)` property on a frozen wrapper.
 */
export function mergeDevice(
  devices: readonly DeviceFingerprintEntry[],
  fingerprint: string | null | undefined,
  now: Date,
): DeviceFingerprintEntry[] {
  if (typeof fingerprint !== 'string') {
    return devices.map((entry) => ({ fp: entry.fp, lastSeenAt: entry.lastSeenAt }));
  }
  const fp = fingerprint.trim();
  if (fp.length === 0) {
    return devices.map((entry) => ({ fp: entry.fp, lastSeenAt: entry.lastSeenAt }));
  }
  const lastSeenAt = now.toISOString();
  const filtered: DeviceFingerprintEntry[] = [];
  for (const entry of devices) {
    if (entry.fp === fp) continue;
    filtered.push({ fp: entry.fp, lastSeenAt: entry.lastSeenAt });
  }
  const next: DeviceFingerprintEntry[] = [{ fp, lastSeenAt }, ...filtered];
  if (next.length > DEVICE_FINGERPRINT_LRU_CAP) {
    return next.slice(0, DEVICE_FINGERPRINT_LRU_CAP);
  }
  return next;
}

// ── Private parsers (mirror the readers in geo.ts / time.ts / device.ts) ─

/**
 * Coerce `login_baselines.countries` jsonb into a string[]. Mirrors
 * `parseCountries` in geo.ts — drivers vary on whether jsonb arrives
 * parsed or as JSON text, so we accept both shapes.
 */
function parseCountries(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Coerce `login_baselines.hour_histogram` jsonb into a length-24
 * number[]. Mirrors `normaliseHistogram` in time.ts — historical
 * rows might have drifted (off-by-one, stringified entries), so we
 * always return an array of exactly 24 finite non-negative integers.
 */
function normaliseHistogram(raw: readonly number[] | unknown): number[] {
  const out = new Array<number>(HOUR_HISTOGRAM_LENGTH).fill(0);
  let source: unknown[] | undefined;
  if (Array.isArray(raw)) source = raw;
  else if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) source = parsed;
    } catch {
      source = undefined;
    }
  }
  if (!source) return out;
  const len = Math.min(source.length, HOUR_HISTOGRAM_LENGTH);
  for (let i = 0; i < len; i++) {
    const v = Number(source[i]);
    out[i] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }
  return out;
}

/**
 * Coerce `login_baselines.device_fingerprints` jsonb into a
 * DeviceFingerprintEntry[]. Mirrors `parseFingerprintList` in
 * device.ts — driver shapes vary, malformed entries are dropped.
 */
function parseFingerprintList(raw: unknown): DeviceFingerprintEntry[] {
  if (Array.isArray(raw)) return coerceEntries(raw);
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? coerceEntries(parsed) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function coerceEntries(raw: readonly unknown[]): DeviceFingerprintEntry[] {
  const out: DeviceFingerprintEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const fp = (entry as { fp?: unknown }).fp;
    const lastSeenAt = (entry as { lastSeenAt?: unknown }).lastSeenAt;
    if (typeof fp !== 'string' || fp.length === 0) continue;
    if (typeof lastSeenAt !== 'string') continue;
    out.push({ fp, lastSeenAt });
  }
  return out;
}
