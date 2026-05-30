/**
 * Device subscore for the Anomaly Detector (admin-setup-wizard task 7.4;
 * Req 11.1–11.6; design §8.3).
 *
 * `deviceSubscore(userId, userAgent, acceptLanguage, attempt?)` derives
 * a stable 16-hex-char fingerprint from the request's `User-Agent` +
 * `Accept-Language` headers, then compares it against the user's
 * `login_baselines.device_fingerprints` LRU to decide whether the
 * attempt is from a previously-unseen device. The result is a
 * {@link Subscore} the {@link AnomalyDetector} aggregator picks up
 * alongside the geo and time subscores (design §8.4); the function
 * also writes the resolved fingerprint and lookup status onto the
 * supplied {@link LoginAttemptDraft} so the caller — `LoginGuard.
 * onSuccess` — can persist a single `INSERT INTO login_attempts`
 * covering all three detectors (design §3.4).
 *
 * The shape mirrors {@link
 *   /apps/cms/src/modules/anomaly/geo.ts createGeoSubscore} and
 * {@link /apps/cms/src/modules/anomaly/time.ts createTimeSubscore}: a
 * factory binds the function to a Database handle (or a stubbed
 * {@link DeviceBaselineLoader} in tests), the default loader is
 * Drizzle-backed against `login_baselines`, and the per-call shape is
 * `(userId, userAgent, acceptLanguage, attempt?)`.
 *
 * Spec mapping (kept linear so each Req maps to one code path):
 *
 *   1. **Req 11.1 + design §8.3 — fingerprint pipeline.** The UA is
 *      first run through {@link normalizeUA}: bound to 1024 chars
 *      (defence against `User-Agent: <huge string>` floods),
 *      lowercased, version-digit groups (`12.34.56`) collapsed to
 *      `#`, and runs of whitespace collapsed to a single space. The
 *      goal is to keep a single browser+OS combination on a stable
 *      fingerprint across patch-level updates; without the version
 *      strip, every minor Chrome / Safari update would invalidate
 *      every user's baseline and produce a flood of false-positive
 *      alerts. The `acceptLanguage` header is then concatenated with
 *      a literal `'|'` separator and lowercased + bounded to 64
 *      chars (design §8.3 code listing) to keep the seed
 *      deterministic regardless of the client's exact `q=` weights.
 *      The combined string is hashed with SHA-256 via the Web Crypto
 *      API and truncated to the first 16 hex characters (= 64-bit
 *      truncate, Req 11.1). 64 bits is plenty for collision
 *      avoidance at LRU cap 20 — birthday-paradox 1 in ~4 billion
 *      for 20 entries — and keeps the column compact.
 *
 *   2. **Design §8.3 — missing/empty UA → unavailable, no warmup.**
 *      An empty or whitespace-only `User-Agent` (or a non-string
 *      input) skips the entire pipeline: the detector returns
 *      `{ value: 0, baselineWarmup: false }` and tags the attempt
 *      `deviceLookupStatus='unavailable'`. The "no warmup" rule
 *      diverges from the geo / time subscores intentionally —
 *      missing UA is a "we have no signal" outcome (a curl request,
 *      an automated tool stripping headers), not a "first few logins
 *      from a new user" outcome. Treating it as warmup would let
 *      anomaly_action='lock' bypasses leak through any time the
 *      attacker remembers to drop the UA header.
 *
 *   3. **Req 11.4 — baseline warmup at `successfulLogins < 3`.** Once
 *      the UA is non-empty and we have a fingerprint, the warmup
 *      gate kicks in at the same threshold as geo (Req 9.4): until
 *      the user has 3 successful logins on record, every device
 *      looks "new" by definition, so the detector returns
 *      `{ value: 0, baselineWarmup: true }`. The `lookupStatus`
 *      stays `'ok'` and the fingerprint is written onto the attempt
 *      so the writer in task 7.5 can seed the LRU.
 *
 *   4. **Req 11.2 / 11.3 — match check.** Past the warmup gate,
 *      `value=1` if the fingerprint isn't present in the baseline
 *      LRU, `value=0` if it is. The LRU's eviction (Req 11.5) is
 *      the writer's responsibility (task 7.5 baseline-store); the
 *      detector here only reads the snapshot.
 *
 *   5. **Req 11.6 — baseline updates** are out of scope for this
 *      module; see `apps/cms/src/modules/anomaly/baseline-store.ts`
 *      (task 7.5). Keeping read and write split mirrors the geo /
 *      time subscores and avoids double-counting the *current*
 *      attempt against the baseline used to score it.
 *
 * Defensive branches:
 *
 *   - Baseline loader rejection (DB pool blip) collapses to "no
 *     baseline" via {@link safeLoadBaseline}, which falls into the
 *     warmup branch. The detector must never fail a successful
 *     login because of its own infrastructure.
 *   - SHA-256 failure (e.g. Web Crypto unavailable in some test
 *     runner) collapses to `deviceLookupStatus='unavailable'` with
 *     subscore 0 and no warmup, matching the missing-UA branch.
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6.
 */

import { eq } from 'drizzle-orm';
import { loginBaselines, type Database } from '@lumibase/database';

import type {
  DeviceBaselineSnapshot,
  DeviceFingerprintEntry,
  LoginAttemptDraft,
  Subscore,
} from './types';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Loads the per-user `login_baselines` snapshot the device detector
 * consults. Defaults to {@link loadDeviceBaselineFromDb}; tests inject
 * a stub returning a known fixture so the detector's branching can be
 * exercised without a real DB row.
 */
export type DeviceBaselineLoader = (
  userId: string,
) => Promise<DeviceBaselineSnapshot | null>;

/**
 * Per-call hooks for {@link createDeviceSubscore}. Production passes a
 * Database handle and lets the factory wire the Postgres baseline
 * loader; tests inject `loadBaseline` directly so the subscore logic
 * is exercised in isolation.
 */
export interface DeviceSubscoreOptions {
  /** Override the baseline loader; defaults to a Drizzle row read. */
  readonly loadBaseline?: DeviceBaselineLoader;
}

/**
 * Bound device subscore — the production-facing function shape.
 * Matches the {@link AnomalyDetector.deviceSubscore} signature in
 * design §6.3, plus the optional `attempt` writer from §3.4.
 */
export type DeviceSubscoreFn = (
  userId: string,
  userAgent: string | null | undefined,
  acceptLanguage: string | null | undefined,
  attempt?: LoginAttemptDraft,
) => Promise<Subscore>;

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Number of successful logins required before the device LRU is
 * considered statistically meaningful. Below this threshold the
 * subscore stays at 0 and flips `baselineWarmup` (Req 11.4). Matches
 * the geo subscore's threshold (Req 9.4) by design — both detectors
 * gate on "user has at least one stable identity baseline".
 */
export const DEVICE_BASELINE_MIN_SUCCESSFUL_LOGINS = 3;

/** LRU cap on `login_baselines.device_fingerprints` (Req 11.5). */
export const DEVICE_FINGERPRINT_LRU_CAP = 20;

/** Maximum length of the User-Agent header we hash (Req 11.1; design §8.3). */
export const MAX_UA_LENGTH = 1024;

/** Maximum length of the Accept-Language header we hash (design §8.3). */
export const MAX_ACCEPT_LANGUAGE_LENGTH = 64;

/** Truncated hex length of the SHA-256 fingerprint (Req 11.1; 64-bit truncate). */
export const FINGERPRINT_HEX_LENGTH = 16;

/**
 * Regex matching dotted version-digit groups (e.g. `12.0.4664.110`).
 * Used by {@link normalizeUA} to collapse patch-level differences so
 * a single browser+OS combination yields a stable fingerprint across
 * minor updates (design §8.3 listing).
 *
 * `\b` boundaries keep us from gobbling random digits inside identifier
 * tokens (e.g. `Win64`); the inner `(?:\.\d+)+` requires at least one
 * dotted group so plain integers (architecture suffixes, build IDs
 * without dots) survive.
 */
export const VERSION_DIGITS_REGEX = /\b\d+(?:\.\d+)+\b/g;

/**
 * Build a device subscore bound to a Database handle. The returned
 * function reads the per-user baseline through {@link
 * loadDeviceBaselineFromDb} unless `options.loadBaseline` is supplied.
 */
export function createDeviceSubscore(
  db: Database,
  options: DeviceSubscoreOptions = {},
): DeviceSubscoreFn {
  const loadBaseline =
    options.loadBaseline ?? ((userId) => loadDeviceBaselineFromDb(db, userId));
  return (userId, userAgent, acceptLanguage, attempt) =>
    deviceSubscoreImpl(userId, userAgent, acceptLanguage, attempt ?? {}, {
      loadBaseline,
    });
}

/**
 * Convenience entry point that mirrors the {@link
 * AnomalyDetector.deviceSubscore} signature in design §6.3. Builds a
 * fresh subscore function on every call from the supplied `db`; in
 * production hot paths prefer {@link createDeviceSubscore} so the
 * baseline loader binds once per request lifecycle rather than once
 * per call.
 */
export function deviceSubscore(
  db: Database,
  userId: string,
  userAgent: string | null | undefined,
  acceptLanguage: string | null | undefined,
  attempt?: LoginAttemptDraft,
  options?: DeviceSubscoreOptions,
): Promise<Subscore> {
  return createDeviceSubscore(db, options)(
    userId,
    userAgent,
    acceptLanguage,
    attempt,
  );
}

// ── Pure pipeline (exported for unit tests) ─────────────────────────────

/**
 * Canonicalise a `User-Agent` string for hashing (Req 11.1; design §8.3).
 *
 *   1. Slice to 1024 chars to bound the work and stop a malicious UA
 *      from forcing a multi-MB hash input.
 *   2. Lowercase so case quirks (`Mozilla/5.0` vs `mozilla/5.0`)
 *      collapse onto the same fingerprint.
 *   3. Replace dotted version-digit groups (`109.0.5414.74`) with
 *      `#` so patch-level updates don't churn the fingerprint.
 *   4. Collapse runs of whitespace into a single space and trim
 *      leading/trailing whitespace.
 *
 * Empty / whitespace-only / non-string inputs return `''`. The caller
 * (`deviceSubscoreImpl`) treats an empty result as the
 * "missing UA → unavailable" branch.
 */
export function normalizeUA(ua: string | null | undefined): string {
  if (typeof ua !== 'string') return '';
  return ua
    .slice(0, MAX_UA_LENGTH)
    .toLowerCase()
    .replace(VERSION_DIGITS_REGEX, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compute the 16-hex-char truncated SHA-256 fingerprint over the
 * normalised UA + Accept-Language pair (Req 11.1; design §8.3).
 *
 * The Accept-Language input is lowercased and bounded to
 * {@link MAX_ACCEPT_LANGUAGE_LENGTH} characters before mixing — this
 * is what the design listing does and keeps the seed deterministic
 * regardless of the client's exact `q=` weights.
 *
 * Returns `''` when the normalised UA is empty so callers can treat
 * "no UA" as a single sentinel without a separate optional return
 * type. Real fingerprints are always exactly 16 lowercase hex chars.
 */
export async function fingerprint(
  ua: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Promise<string> {
  const normalisedUA = normalizeUA(ua);
  if (normalisedUA.length === 0) return '';
  const lang = (typeof acceptLanguage === 'string' ? acceptLanguage : '')
    .slice(0, MAX_ACCEPT_LANGUAGE_LENGTH)
    .toLowerCase();
  const input = `${normalisedUA}|${lang}`;
  return sha256Truncated(input, FINGERPRINT_HEX_LENGTH);
}

/**
 * SHA-256 the input via the Web Crypto API and return the first
 * `hexLength` hex characters of the digest.
 *
 * Web Crypto is available on every supported runtime — Node ≥ 18,
 * Cloudflare Workers, modern browsers — so we don't need a fallback.
 * If `crypto.subtle.digest` rejects (e.g. a stripped-down test
 * environment), the caller catches the rejection and falls back to
 * the `'unavailable'` branch.
 */
async function sha256Truncated(input: string, hexLength: number): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  // We only need the prefix, so stop once we've emitted enough chars.
  // hexLength is even in practice (16); the loop guard handles odd
  // values defensively.
  const byteCount = Math.ceil(hexLength / 2);
  for (let i = 0; i < byteCount; i++) {
    hex += view[i]!.toString(16).padStart(2, '0');
  }
  return hex.slice(0, hexLength);
}

// ── Implementation ──────────────────────────────────────────────────────

interface ResolvedDeps {
  readonly loadBaseline: DeviceBaselineLoader;
}

/**
 * Core branching logic. Sequence (kept linear so each Req maps to
 * one block):
 *
 *   1. Default the attempt fields to `'unavailable'` / `null` so any
 *      early-return path leaves a coherent row for the caller's
 *      `INSERT INTO login_attempts`.
 *   2. **Design §8.3** — Empty/missing UA: subscore 0, **no warmup**,
 *      status `'unavailable'`. Skip the baseline read entirely
 *      because it can't help us — we have nothing to look up.
 *   3. **Req 11.1** — Compute the fingerprint via
 *      {@link fingerprint}. A failed `crypto.subtle.digest` (rare —
 *      only really happens in stripped-down test runtimes) collapses
 *      to the same `'unavailable'` branch as missing UA.
 *   4. **Req 11.4** — Warmup gate on `successfulLogins < 3`.
 *      Fingerprint is still recorded onto the attempt so the writer
 *      in task 7.5 can seed the LRU.
 *   5. **Req 11.2 / 11.3** — Match check against the LRU `fp` field.
 */
async function deviceSubscoreImpl(
  userId: string,
  userAgent: string | null | undefined,
  acceptLanguage: string | null | undefined,
  attempt: LoginAttemptDraft,
  deps: ResolvedDeps,
): Promise<Subscore> {
  // Default the attempt fields so any early return leaves a coherent row.
  attempt.deviceLookupStatus = 'unavailable';
  attempt.deviceFingerprint = null;

  // Design §8.3 — missing/empty UA short-circuits before any baseline
  // read. The "no warmup" rule is intentional: a missing UA means
  // "no signal", not "first few logins from a real user".
  const normalised = normalizeUA(userAgent);
  if (normalised.length === 0) {
    return { value: 0, baselineWarmup: false };
  }

  // Req 11.1 — compute the fingerprint. A digest failure (Web Crypto
  // unavailable in a stripped-down test runtime) collapses to the
  // same unavailable branch as missing UA: no warmup, no signal.
  let fp: string;
  try {
    fp = await fingerprint(userAgent, acceptLanguage);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[anomaly/device] fingerprint computation failed; treating as unavailable',
      err,
    );
    return { value: 0, baselineWarmup: false };
  }

  // Defensive: an empty fingerprint past the empty-UA gate would
  // indicate a bug in `fingerprint`; treat it as unavailable rather
  // than letting an empty string pollute the baseline LRU.
  if (fp.length === 0) {
    return { value: 0, baselineWarmup: false };
  }

  attempt.deviceFingerprint = fp;
  attempt.deviceLookupStatus = 'ok';

  // Read baseline now — we have something useful to compare against.
  const baseline = await safeLoadBaseline(deps.loadBaseline, userId);
  const successfulLogins = baseline?.successfulLogins ?? 0;

  // Req 11.4 — warmup wins over signal.
  if (successfulLogins < DEVICE_BASELINE_MIN_SUCCESSFUL_LOGINS) {
    return { value: 0, baselineWarmup: true };
  }

  // Req 11.2 / 11.3 — known fingerprint vs. unknown.
  const known =
    baseline?.deviceFingerprints.some((entry) => entry.fp === fp) ?? false;
  return { value: known ? 0 : 1, baselineWarmup: false };
}

/**
 * Wrap a baseline loader call so a transient DB error (e.g.
 * connection pool blip) doesn't bubble up into the LoginGuard hook.
 * On rejection the device detector falls back to "no baseline known",
 * which collapses to warmup mode — strictly safer than crashing the
 * login.
 */
async function safeLoadBaseline(
  loader: DeviceBaselineLoader,
  userId: string,
): Promise<DeviceBaselineSnapshot | null> {
  try {
    return await loader(userId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[anomaly/device] baseline load failed; treating as warmup',
      err,
    );
    return null;
  }
}

// ── Baseline loader ─────────────────────────────────────────────────────

/**
 * Read the device-relevant subset of `login_baselines` for a user.
 *
 * The detector only needs `deviceFingerprints` and `successfulLogins`;
 * the other columns (`countries`, `hourHistogram`) belong to the geo
 * / time subscores. Returning `null` when the row is missing keeps
 * the detector's warmup branch unified — the caller doesn't have to
 * special-case "first ever login" vs. "loaded baseline with zero
 * history".
 *
 * `deviceFingerprints` is stored as `jsonb` (design §3.5); driver
 * shapes vary, so {@link parseFingerprintList} coerces the result
 * regardless of whether we get an array or a JSON string here.
 */
export async function loadDeviceBaselineFromDb(
  db: Database,
  userId: string,
): Promise<DeviceBaselineSnapshot | null> {
  const rows = await db
    .select({
      deviceFingerprints: loginBaselines.deviceFingerprints,
      successfulLogins: loginBaselines.successfulLogins,
    })
    .from(loginBaselines)
    .where(eq(loginBaselines.userId, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    deviceFingerprints: parseFingerprintList(row.deviceFingerprints),
    successfulLogins: Number.isInteger(row.successfulLogins)
      ? row.successfulLogins
      : 0,
  };
}

/**
 * Coerce the raw `device_fingerprints` jsonb column into a fixed
 * array of {@link DeviceFingerprintEntry}. Mirrors `parseCountries`
 * (geo.ts) and `parseHourHistogram` (time.ts) in shape:
 *
 *   - `Array.isArray` covers the parsed-array case (postgres-js,
 *     node-postgres on jsonb columns).
 *   - The string branch covers drivers that hand back JSON text on
 *     raw SQL.
 *   - Each entry is validated to be `{ fp: string, lastSeenAt:
 *     string }`; malformed entries are dropped silently so a single
 *     bad row in a historical baseline can't crash a login.
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
