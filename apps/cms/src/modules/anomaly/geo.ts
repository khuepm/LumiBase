/**
 * Geo subscore for the Anomaly Detector (admin-setup-wizard task 7.2;
 * Req 9.1–9.6; design §8.1).
 *
 * `geoSubscore(userId, ip, attempt)` resolves the request IP to a
 * country code via the MaxMind GeoLite2 database, then compares it
 * against the user's `login_baselines.countries` to decide whether
 * the attempt is from a previously-unseen geography. The result is a
 * {@link Subscore} the {@link AnomalyDetector} aggregator picks up
 * (design §8.4); the function also writes the resolved country and
 * lookup status onto the supplied {@link LoginAttemptDraft} so the
 * caller can persist a single `login_attempts` row covering all
 * anomaly outputs.
 *
 * The module is built around three principles, each tied to a
 * specific spec line:
 *
 *   1. **Lazy MMDB load (design §8.1).** The reader is built on
 *      first call via dynamic `import('maxmind')` and cached in a
 *      module-level promise. We don't import `maxmind` at top level
 *      because:
 *        - The Cloudflare Workers build of the CMS never installs
 *          the package — Workers can't read filesystem MMDB files —
 *          so a top-level import would break the bundle.
 *        - Self-hosted Node runs may legitimately ship without the
 *          GeoLite2 file; we want graceful degradation
 *          (`geoLookupStatus='unavailable'`), not a crash on import.
 *      The dynamic import lets the same module behave correctly in
 *      every deploy: when `maxmind` and the MMDB file are both
 *      present, the lookup runs; otherwise the first lookup records
 *      `geoLookupStatus='unavailable'` and future availability checks
 *      quietly degrade.
 *
 *   2. **2 s timeout via Promise wrapper (Req 9.1).** Even though
 *      MMDB lookups are sub-millisecond when the file is loaded, the
 *      contract has to hold for the future world where this module
 *      might delegate to an external service (ip-api.com, ipinfo.io)
 *      per the design §15.3 open question. {@link withTimeout}
 *      rejects with a sentinel error after 2 s; the catch handler
 *      flips the status to `'timeout'` so the caller can record it
 *      in `login_attempts.geo_lookup_status` for forensics.
 *
 *   3. **Skip private/loopback IPs (Req 9.5).** {@link
 *      isPrivateOrLoopback} short-circuits the MMDB call before
 *      `maxmind` ever sees the input. RFC 1918, link-local, and
 *      loopback addresses don't have meaningful country mappings;
 *      forcing the lookup would return either `null` or a misleading
 *      "Anonymous Proxy" verdict that would create false positives
 *      on developer machines and ops bastions.
 *
 * The "warmup" rule from Req 9.4 — `successfulLogins < 3` →
 * `baselineWarmup=true, value=0` — is the one place where the
 * detector intentionally returns a non-trivial subscore even when
 * the IP looks foreign. The aggregator's contract (Req 12.5) means
 * a warmup-flagged attempt skips the threshold-action dispatch even
 * if other detectors would trigger, so flipping the flag here is
 * the canonical way to "trust the new user" until they have enough
 * history.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6.
 */

import { eq } from 'drizzle-orm';
import { loginBaselines, type Database } from '@lumibase/database';

import { isPrivateOrLoopback } from './private-ip';
import type {
  GeoBaselineSnapshot,
  GeoLookupStatus,
  LoginAttemptDraft,
  Subscore,
} from './types';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Resolves a single IP to its ISO-3166 alpha-2 country code.
 *
 * Returns the uppercased two-letter code on a hit, `null` on a clean
 * "no country known for this IP" miss, and rejects when the
 * underlying lookup fails (the caller wraps that into the timeout /
 * unavailable branches).
 *
 * Exposed as an interface so production wires the MMDB-backed
 * implementation while tests inject a deterministic stub. The method
 * is async because external-service variants (ip-api.com etc.) need
 * to be — the in-process MMDB reader resolves synchronously inside
 * the promise.
 */
export interface GeoLookup {
  /** `true` when the underlying datasource is loaded and answering. */
  available(): boolean;
  /** Resolve `ip` to an ISO-3166 alpha-2 country code, or `null`. */
  lookupCountry(ip: string): Promise<string | null>;
}

/**
 * Loads the per-user `login_baselines` snapshot the geo detector
 * consults. Defaults to {@link loadGeoBaselineFromDb}; tests inject a
 * stub returning a known fixture so the detector's branching can be
 * exercised without a real DB row.
 */
export type GeoBaselineLoader = (
  userId: string,
) => Promise<GeoBaselineSnapshot | null>;

/**
 * Per-call hooks for {@link createGeoSubscore}. Production passes a
 * Database handle and lets the factory wire the MMDB-backed lookup +
 * Postgres baseline loader; tests inject `lookup` and `loadBaseline`
 * directly so the subscore logic is exercised in isolation.
 */
export interface GeoSubscoreOptions {
  /** Path to the GeoLite2-Country MMDB file. Defaults to design §8.1 layout. */
  readonly mmdbPath?: string;
  /** Override the GeoIP lookup; defaults to MMDB-backed. */
  readonly lookup?: GeoLookup;
  /** Override the baseline loader; defaults to a Drizzle row read. */
  readonly loadBaseline?: GeoBaselineLoader;
  /** Wall-clock budget for a single lookup. Defaults to 2 000 ms (Req 9.1). */
  readonly timeoutMs?: number;
}

/**
 * Bound geo subscore — the production-facing function shape.
 * Matches the {@link AnomalyDetector.geoSubscore} signature in
 * design §6.3, plus the optional `attempt` writer from §3.4.
 */
export type GeoSubscoreFn = (
  userId: string,
  ip: string,
  attempt?: LoginAttemptDraft,
) => Promise<Subscore>;

// ── Public surface ──────────────────────────────────────────────────────

/** Default location for the MMDB file; design §8.1 / task 7.2 spec. */
export const DEFAULT_MMDB_PATH = 'data/geoip/GeoLite2-Country.mmdb';
/** Default timeout for a single GeoIP lookup; Req 9.1 mandates 2 seconds. */
export const DEFAULT_TIMEOUT_MS = 2_000;
/** Sentinel error message for the timeout wrapper; tests use it to assert the path. */
export const GEO_TIMEOUT_ERROR_MESSAGE = 'geo-lookup-timeout';

/**
 * Build a geo subscore bound to a Database handle. The returned
 * function reads the per-user baseline through {@link
 * loadGeoBaselineFromDb} unless `options.loadBaseline` is supplied,
 * and uses the MMDB-backed {@link GeoLookup} unless `options.lookup`
 * is supplied.
 *
 * A new module-level cached MMDB reader is constructed the first
 * time `lookup` is needed; the cache is keyed on `mmdbPath` so two
 * factories pointing at the same file share a single loaded reader.
 */
export function createGeoSubscore(
  db: Database,
  options: GeoSubscoreOptions = {},
): GeoSubscoreFn {
  const loadBaseline =
    options.loadBaseline ?? ((userId) => loadGeoBaselineFromDb(db, userId));
  const lookup = options.lookup ?? createMmdbLookup(options.mmdbPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return (userId, ip, attempt) =>
    geoSubscoreImpl(userId, ip, attempt ?? {}, {
      loadBaseline,
      lookup,
      timeoutMs,
    });
}

/**
 * Convenience entry point that mirrors the {@link
 * AnomalyDetector.geoSubscore} signature in design §6.3. Builds a
 * fresh subscore function on every call from the supplied `db`; in
 * production hot paths prefer {@link createGeoSubscore} so the MMDB
 * reader and baseline loader bind once per request lifecycle rather
 * than once per call.
 */
export function geoSubscore(
  db: Database,
  userId: string,
  ip: string,
  attempt?: LoginAttemptDraft,
  options?: GeoSubscoreOptions,
): Promise<Subscore> {
  return createGeoSubscore(db, options)(userId, ip, attempt);
}

// ── Implementation ──────────────────────────────────────────────────────

interface ResolvedDeps {
  readonly loadBaseline: GeoBaselineLoader;
  readonly lookup: GeoLookup;
  readonly timeoutMs: number;
}

/**
 * Core branching logic. Sequence (kept linear so each Req maps to one
 * block):
 *
 *   1. Mark the attempt with a default `geoLookupStatus='unavailable'`
 *      so any early-return path leaves the field populated. The
 *      caller's `INSERT` then never sees `null` for an attempt that
 *      legitimately bypassed the lookup.
 *
 *   2. **Req 9.5** — Private/loopback IPs and the `'unknown'`
 *      sentinel from {@link extractClientIp}: subscore `0` with
 *      `baselineWarmup` from the user's history (loaded below) so
 *      the aggregator's warmup-folding still works on later
 *      attempts. We *don't* short-circuit before reading the
 *      baseline because keeping the path uniform makes timing
 *      analysis simpler — a loopback request and a public-IP
 *      request both incur one DB read.
 *
 *   3. **Req 9.4** — Warmup mode: `successfulLogins < 3` always
 *      returns `value=0, baselineWarmup=true`. We still issue the
 *      MMDB lookup so `attempt.countryCode` is populated for the
 *      audit log — a warmup user is still interesting to operators
 *      even if no anomaly fires.
 *
 *   4. **Req 9.2 / 9.3** — Unknown country (`!baseline.countries.
 *      includes(country)`) → `value=1`. Known country → `value=0`.
 *
 * Errors are caught broadly: a thrown lookup, a malformed baseline
 * row, or a baseline loader rejection all collapse to `{ value: 0,
 * baselineWarmup: false }` with `geoLookupStatus='unavailable'`.
 * The detector must never block a successful login because of its
 * own infrastructure — that's the explicit contract in Req 9.5
 * ("when GeoIP lookup fails ... gán `geoAnomalySubscore = 0.0`").
 */
async function geoSubscoreImpl(
  userId: string,
  ip: string,
  attempt: LoginAttemptDraft,
  deps: ResolvedDeps,
): Promise<Subscore> {
  // Default the attempt fields so any early return leaves a coherent row.
  attempt.geoLookupStatus = 'unavailable';
  attempt.countryCode = null;

  const baseline = await safeLoadBaseline(deps.loadBaseline, userId);
  const successfulLogins = baseline?.successfulLogins ?? 0;
  const isWarmup = successfulLogins < 3;

  // Req 9.5 — short-circuit private/loopback. The lookup status stays
  // `'unavailable'` and we don't touch `countryCode`.
  if (isPrivateOrLoopback(ip)) {
    return { value: 0, baselineWarmup: isWarmup };
  }

  // The MMDB reader / external service is known to be unreachable —
  // same outcome as a private IP on this axis. Lazy lookups should
  // report available until their first lookup has tried to load.
  if (!deps.lookup.available()) {
    return { value: 0, baselineWarmup: isWarmup };
  }

  // Req 9.1 — bounded lookup. The withTimeout wrapper rejects with
  // GEO_TIMEOUT_ERROR_MESSAGE; the catch block below distinguishes
  // that case so the timeout vs. generic-failure flag stays
  // observable in `login_attempts.geo_lookup_status`.
  let countryCode: string | null;
  try {
    countryCode = await withTimeout(
      deps.lookup.lookupCountry(ip),
      deps.timeoutMs,
    );
  } catch (err) {
    attempt.geoLookupStatus = isTimeoutError(err) ? 'timeout' : 'unavailable';
    return { value: 0, baselineWarmup: isWarmup };
  }

  if (!countryCode) {
    // Reader didn't know this IP — keep status `'unavailable'` to
    // surface "GeoIP couldn't help" on the audit row; subscore
    // collapses to 0 per Req 9.5.
    return { value: 0, baselineWarmup: isWarmup };
  }

  // Successful lookup — record the country and flip the status.
  attempt.countryCode = countryCode;
  attempt.geoLookupStatus = 'ok';

  // Req 9.4 — warmup wins over signal.
  if (isWarmup) {
    return { value: 0, baselineWarmup: true };
  }

  // Req 9.2 / 9.3 — country mismatch / match.
  const known = baseline?.countries.includes(countryCode) ?? false;
  return { value: known ? 0 : 1, baselineWarmup: false };
}

/**
 * Wrap a lookup loader call so a transient DB error (e.g.
 * connection pool blip) doesn't bubble up into the LoginGuard hook.
 * On rejection the geo detector falls back to "no baseline known",
 * which collapses to warmup mode — strictly safer than crashing the
 * login.
 */
async function safeLoadBaseline(
  loader: GeoBaselineLoader,
  userId: string,
): Promise<GeoBaselineSnapshot | null> {
  try {
    return await loader(userId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[anomaly/geo] baseline load failed; treating as warmup', err);
    return null;
  }
}

// ── Baseline loader ─────────────────────────────────────────────────────

/**
 * Read the geo-relevant subset of `login_baselines` for a user.
 *
 * The detector only needs `countries` and `successfulLogins`; the
 * other columns (`hourHistogram`, `deviceFingerprints`) belong to
 * the time / device subscores and are read by their respective
 * modules. Returning `null` when the row is missing keeps the
 * detector's warmup branch unified — the caller doesn't have to
 * special-case "first ever login" vs. "loaded baseline with zero
 * history".
 *
 * `countries` is stored as `jsonb` (design §3.5) so the driver hands
 * it back as either a parsed array or — on some adapters — a JSON
 * string. We normalise to an array of strings so the `Array.includes`
 * check downstream is type-safe regardless of the driver shape.
 */
export async function loadGeoBaselineFromDb(
  db: Database,
  userId: string,
): Promise<GeoBaselineSnapshot | null> {
  const rows = await db
    .select({
      countries: loginBaselines.countries,
      successfulLogins: loginBaselines.successfulLogins,
    })
    .from(loginBaselines)
    .where(eq(loginBaselines.userId, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    countries: parseCountries(row.countries),
    successfulLogins: Number.isInteger(row.successfulLogins)
      ? row.successfulLogins
      : 0,
  };
}

function parseCountries(raw: unknown): string[] {
  // jsonb with a typed default `[]` yields an array on postgres-js;
  // node-postgres returns the same. Some drivers return a string when
  // the column is queried via raw SQL — guard both shapes.
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((e): e is string => typeof e === 'string')
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ── MMDB-backed lookup (lazy) ───────────────────────────────────────────

interface MaxmindReader {
  get(ip: string): unknown;
}

interface MaxmindModule {
  open<T>(path: string): Promise<{ get(ip: string): T | null }>;
}

/**
 * Cached MMDB reader factory keyed by absolute path. Storing per
 * path lets multiple factories — production + a test that points at
 * a fixture mmdb — coexist without leaking readers between
 * configurations.
 *
 * Each entry holds the in-flight `Promise<Reader | null>` so
 * concurrent first-call requests share a single underlying load.
 * `null` means "package or file unavailable, degrade gracefully".
 */
const readerCache = new Map<string, Promise<MaxmindReader | null>>();

/**
 * Build a {@link GeoLookup} backed by `maxmind` + the GeoLite2
 * MMDB file. The lookup loads lazily on first use; until the first
 * load attempt completes, `available()` returns `true` so callers do
 * not skip the lookup that initializes the reader.
 *
 * Path resolution honours these knobs (in order):
 *
 *   1. Explicit `mmdbPath` argument — preferred for tests and
 *      operators who provision the file at a non-default path.
 *   2. `process.env.LUMIBASE_GEOIP_PATH` — escape hatch for
 *      docker-compose deploys mounting the file elsewhere.
 *   3. The default `data/geoip/GeoLite2-Country.mmdb` from design
 *      §8.1 / task 7.2 spec.
 */
export function createMmdbLookup(mmdbPath?: string): GeoLookup {
  const resolvedPath = resolveMmdbPath(mmdbPath);
  let cached: MaxmindReader | null = null;
  let loaded = false;
  let inflight: Promise<MaxmindReader | null> | null = null;

  const ensure = (): Promise<MaxmindReader | null> => {
    if (loaded) return Promise.resolve(cached);
    if (!inflight) {
      const cacheHit = readerCache.get(resolvedPath);
      if (cacheHit) {
        inflight = cacheHit;
      } else {
        inflight = loadMmdbReader(resolvedPath);
        readerCache.set(resolvedPath, inflight);
      }
      inflight
        .then((r) => {
          cached = r;
          loaded = true;
        })
        .catch(() => {
          cached = null;
          loaded = true;
        });
    }
    return inflight;
  };

  return {
    available() {
      return !loaded || cached !== null;
    },
    async lookupCountry(ip) {
      const reader = await ensure();
      if (!reader) return null;
      const record = reader.get(ip);
      return extractIsoCountry(record);
    },
  };
}

/**
 * Resolve the MMDB path with the operator-friendly fallback chain.
 * Path resolution stays string-only here — `node:path` would couple
 * the module to the Node runtime, but the helper is callable from
 * the bundler step too. {@link loadMmdbReader} does the actual
 * filesystem touch.
 */
function resolveMmdbPath(explicit: string | undefined): string {
  if (explicit && explicit.length > 0) return explicit;
  const envVal =
    typeof process !== 'undefined' && process.env
      ? process.env.LUMIBASE_GEOIP_PATH
      : undefined;
  if (envVal && envVal.length > 0) return envVal;
  return DEFAULT_MMDB_PATH;
}

/**
 * Dynamically import `maxmind`, open the MMDB file at `path`, and
 * return a thin reader. Returns `null` for any failure — missing
 * package, missing file, malformed file — so the geo detector can
 * fall through to `geoLookupStatus='unavailable'` without surfacing
 * the underlying error to the request path.
 *
 * The dynamic import is the deliberate seam: it works on Node (where
 * `maxmind` is installed and can read the filesystem), no-ops on
 * Cloudflare Workers (where the dependency isn't bundled and there's
 * no filesystem to read from), and stays out of the way of tests
 * that inject their own {@link GeoLookup}.
 */
async function loadMmdbReader(path: string): Promise<MaxmindReader | null> {
  let mod: MaxmindModule;
  try {
    mod = (await import('maxmind')) as unknown as MaxmindModule;
  } catch {
    // Package not installed (Workers build, optional dep skipped).
    return null;
  }

  try {
    const reader = await mod.open<unknown>(path);
    return reader as MaxmindReader;
  } catch (err) {
    // File missing / unreadable / format mismatch — log once at
    // startup level so operators can spot the misconfiguration, then
    // stay silent on subsequent calls (the cached `null` short-
    // circuits future opens).
    // eslint-disable-next-line no-console
    console.warn(
      `[anomaly/geo] failed to open GeoLite2 MMDB at "${path}"; geo subscore disabled`,
      err,
    );
    return null;
  }
}

/**
 * Pull the ISO-3166 alpha-2 country code out of a GeoLite2-Country
 * record. The shape is `{ country: { iso_code: 'US' }, ... }` —
 * see https://github.com/maxmind/MaxMind-DB-Reader-node — but we
 * accept a few shapes defensively in case an operator points us at
 * a GeoLite2-City file (the city DB has the same `country.iso_code`
 * path) or a custom MMDB.
 */
function extractIsoCountry(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  const country = (record as { country?: unknown }).country;
  if (!country || typeof country !== 'object') return null;
  const iso = (country as { iso_code?: unknown }).iso_code;
  if (typeof iso !== 'string' || iso.length === 0) return null;
  return iso.toUpperCase();
}

// ── Timeout wrapper ─────────────────────────────────────────────────────

/**
 * Race `promise` against a `setTimeout`-backed rejection. Returns
 * the original promise's value on success, rejects with an `Error`
 * whose `message` is {@link GEO_TIMEOUT_ERROR_MESSAGE} on timeout.
 *
 * `unref()` is called on the timer where supported so a stalled
 * lookup doesn't keep a Node process alive past its expected exit;
 * Workers / browsers ignore the missing method silently via the
 * optional chain.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(GEO_TIMEOUT_ERROR_MESSAGE));
    }, timeoutMs);
    // Node's setTimeout returns a Timeout object with .unref(); DOM
    // setTimeout returns a number. Guard both.
    (timer as { unref?: () => void } | undefined)?.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error && err.message === GEO_TIMEOUT_ERROR_MESSAGE
  );
}

/**
 * Drop the cached MMDB reader entries — exported for tests so they
 * can swap fixtures across `describe` blocks. Production code never
 * needs to call this; the cache survives for the process lifetime.
 */
export function __resetMmdbReaderCacheForTests(): void {
  readerCache.clear();
}
