import { releaseManifests, settings, type Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/contracts/utils';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AuditLogger } from '../audit/logger';
import {
  MANIFEST_MAX_PAYLOAD_CHARS,
  parseReleasePublicKeys,
  verifyReleaseManifest,
  type ManifestRejection,
} from './manifest';
import {
  RELEASE_FLAGS,
  SITE_RELEASE_FLAGS_SETTINGS_KEY,
  siteSettingsKeysOf,
  type ReleaseFlagDefinition,
} from './registry';
import {
  clearManifestCache,
  loadAcceptedManifest,
  resetReleaseStateForTests,
  trustedAcceptedManifest,
  type ReleaseEnv,
  type StoredManifest,
} from './state';
import { asRecord, composeSiteValues, groupSiteChanges } from './storage';
import { parseReleaseFlagOverrides, resolveReleaseFlag, type ReleaseFlagState } from './resolver';

export { loadAcceptedManifest, trustedAcceptedManifest, type ReleaseEnv, type StoredManifest } from './state';

/**
 * Storage and orchestration for release flags (#869).
 *
 * Resource classification (DoD §2b):
 *  - **Deployment-wide**: the accepted manifest (`lumibase_release_manifests`,
 *    a singleton row), the env overrides and the trusted public keys. They decide
 *    what this deployment has released and contain no tenant data.
 *  - **Per site**: each site's choices for `siteToggle` flags, stored in
 *    `lumibase_settings` (key `release.flags`, already under `site_isolation`)
 *    and cached under `release-flags:site:v2:{siteId}`; legacy switches (#896)
 *    keep their choice in their original settings object (`./storage`).
 */

export const SITE_RELEASE_FLAGS_KEY = SITE_RELEASE_FLAGS_SETTINGS_KEY;
const SITE_CACHE_TTL_SECONDS = 60;
const DEFAULT_REFRESH_SECONDS = 300;
const MIN_REFRESH_SECONDS = 60;
const PULL_TIMEOUT_MS = 5_000;

// `v2` (#896): the cached value now also carries legacy switches.
export const siteReleaseCacheKey = (siteId: string) => `release-flags:site:v2:${siteId}`;

/** Who triggered an accept, for the instance-level audit trail. */
export interface ReleaseAuditContext {
  readonly actorEmail?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

/**
 * Release decisions affect every tenant, so they are audited at instance
 * scope (`site_id` NULL) — one trail whichever site the caller went through,
 * and also for background pulls that have no caller. Best effort.
 */
export async function writeReleaseAudit(
  systemDb: Database,
  event: string,
  metadata: Record<string, unknown>,
  ctx: ReleaseAuditContext = {},
): Promise<void> {
  try {
    await new AuditLogger({ db: systemDb, siteId: null }).write({
      event,
      actorEmail: ctx.actorEmail ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId ?? null,
      metadata,
    });
  } catch (err) {
    console.warn('[release-flags] audit write failed', formatSafeError(err));
  }
}

export type AcceptOutcome =
  | { ok: true; unchanged: boolean; manifest: StoredManifest; unknownKeys: string[] }
  | { ok: false; reason: ManifestRejection | 'KEYS_NOT_CONFIGURED' };

/**
 * Verify `input` and, when it is newer than the stored one, persist it. The
 * write is one upsert whose update applies only when `issued_at_ms` is
 * strictly greater, so two replicas pulling at once, or a replay racing a
 * fresh manifest, cannot store an older manifest over a newer one.
 */
export async function acceptReleaseManifest(args: {
  systemDb: Database;
  env: ReleaseEnv;
  input: unknown;
  source: 'push' | 'pull';
  actorUserId: string | null;
  audit?: ReleaseAuditContext;
  now?: number;
  registry?: ReadonlyMap<string, ReleaseFlagDefinition>;
}): Promise<AcceptOutcome> {
  const publicKeys = parseReleasePublicKeys(args.env.LUMIBASE_RELEASE_PUBLIC_KEYS);
  if (Object.keys(publicKeys).length === 0) return { ok: false, reason: 'KEYS_NOT_CONFIGURED' };

  clearManifestCache();
  const current = await loadAcceptedManifest(args.systemDb);
  const now = args.now ?? Date.now();
  const verified = await verifyReleaseManifest(args.input, {
    publicKeys,
    instanceId: args.env.LUMIBASE_INSTANCE_ID?.trim() || null,
    now,
    current: current ? { issuedAtMs: current.issuedAtMs, payload: current.envelope.payload } : null,
  });
  if (!verified.ok) return { ok: false, reason: verified.reason };

  const registry = args.registry ?? RELEASE_FLAGS;
  const unknownKeys = Object.keys(verified.manifest.payload.flags).filter((key) => !registry.has(key));
  if (verified.unchanged && current) return { ok: true, unchanged: true, manifest: current, unknownKeys };

  const record: StoredManifest = {
    envelope: verified.manifest.envelope,
    issuedAt: verified.manifest.payload.issuedAt,
    issuedAtMs: verified.manifest.issuedAtMs,
    flags: verified.manifest.payload.flags,
    acceptedAt: new Date(now).toISOString(),
    source: args.source,
    acceptedBy: args.actorUserId,
  };
  const written = await args.systemDb
    .insert(releaseManifests)
    .values({ id: 'current', issuedAtMs: record.issuedAtMs, manifest: record, updatedAt: new Date(now) })
    .onConflictDoUpdate({
      target: releaseManifests.id,
      set: { issuedAtMs: record.issuedAtMs, manifest: record, updatedAt: new Date(now) },
      setWhere: sql`${releaseManifests.issuedAtMs} < ${record.issuedAtMs}`,
    })
    .returning({ id: releaseManifests.id });
  clearManifestCache();

  if (written.length === 0) {
    // Another replica (or a racing pull) may have just stored this very
    // manifest: that is success, not STALE.
    const stored = await loadAcceptedManifest(args.systemDb);
    if (stored && stored.issuedAtMs === record.issuedAtMs && stored.envelope.payload === record.envelope.payload) {
      return { ok: true, unchanged: true, manifest: stored, unknownKeys };
    }
    return { ok: false, reason: 'STALE' };
  }
  await writeReleaseAudit(
    args.systemDb,
    'release_flags.manifest_accepted',
    { keyId: record.envelope.keyId, issuedAt: record.issuedAt, flags: record.flags, source: record.source },
    args.audit,
  );
  return { ok: true, unchanged: false, manifest: record, unknownKeys };
}

// ─── Pull channel (opt-in) ───────────────────────────────────────────────────

export type PullOutcome =
  | { ok: true; unchanged: boolean; issuedAt: string }
  | { ok: false; reason: string };

export interface PullStatus {
  readonly at: string;
  readonly ok: boolean;
  readonly reason?: string;
  readonly issuedAt?: string;
}

let lastPullAttemptAt = 0;
let lastPullStatus: PullStatus | null = null;

/** Last pull attempt in this process (for the status endpoint). */
export function lastReleasePullStatus(): PullStatus | null {
  return lastPullStatus;
}

/** `https:` anywhere; `http:` only for loopback, so local testing works. */
export function manifestUrlAllowed(raw: string | undefined): URL | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url;
    return null;
  } catch {
    return null;
  }
}

export function refreshIntervalMs(env: ReleaseEnv): number {
  const seconds = Number(env.LUMIBASE_RELEASE_MANIFEST_REFRESH_S);
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_REFRESH_SECONDS;
  return Math.max(value, MIN_REFRESH_SECONDS) * 1000;
}

/**
 * Fetch the manifest from `LUMIBASE_RELEASE_MANIFEST_URL` and accept it. A
 * failure of any kind leaves the stored manifest in force — losing contact
 * with LumiBase never turns a released feature off.
 */
export async function pullReleaseManifest(args: {
  systemDb: Database;
  env: ReleaseEnv;
  fetchImpl?: typeof fetch;
  now?: number;
  audit?: ReleaseAuditContext;
}): Promise<PullOutcome> {
  const now = args.now ?? Date.now();
  lastPullAttemptAt = now;
  const finish = (outcome: PullOutcome): PullOutcome => {
    lastPullStatus = outcome.ok
      ? { at: new Date(now).toISOString(), ok: true, issuedAt: outcome.issuedAt }
      : { at: new Date(now).toISOString(), ok: false, reason: outcome.reason };
    if (!outcome.ok) console.warn('[release-flags] manifest pull failed', { reason: outcome.reason });
    return outcome;
  };

  const url = manifestUrlAllowed(args.env.LUMIBASE_RELEASE_MANIFEST_URL);
  if (!url) return finish({ ok: false, reason: 'PULL_NOT_CONFIGURED' });

  let body: unknown;
  try {
    // `manual` + refuse 3xx rather than `redirect: 'error'`, which the Workers
    // runtime does not accept; following redirects is refused either way.
    const res = await (args.fetchImpl ?? fetch)(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
    });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      return finish({ ok: false, reason: 'REDIRECT_REFUSED' });
    }
    if (!res.ok) return finish({ ok: false, reason: `HTTP_${res.status}` });
    const text = await res.text();
    if (text.length > MANIFEST_MAX_PAYLOAD_CHARS * 2) return finish({ ok: false, reason: 'TOO_LARGE' });
    body = JSON.parse(text);
  } catch (err) {
    console.warn('[release-flags] manifest fetch error', formatSafeError(err));
    return finish({ ok: false, reason: 'FETCH_FAILED' });
  }

  const outcome = await acceptReleaseManifest({
    systemDb: args.systemDb,
    env: args.env,
    input: body,
    source: 'pull',
    actorUserId: null,
    audit: args.audit,
    now,
  });
  if (!outcome.ok) return finish({ ok: false, reason: outcome.reason });
  return finish({ ok: true, unchanged: outcome.unchanged, issuedAt: outcome.manifest.issuedAt });
}

/**
 * Start a background pull when one is due. Returns the promise (or `null` when
 * nothing was started) so the caller can hand it to `waitUntil`; never blocks
 * flag evaluation, which keeps using the stored manifest meanwhile.
 */
export function maybeStartReleasePull(args: {
  systemDb: Database;
  env: ReleaseEnv;
  now?: number;
}): Promise<unknown> | null {
  if (!manifestUrlAllowed(args.env.LUMIBASE_RELEASE_MANIFEST_URL)) return null;
  const now = args.now ?? Date.now();
  if (now - lastPullAttemptAt < refreshIntervalMs(args.env)) return null;
  lastPullAttemptAt = now;
  return pullReleaseManifest({ systemDb: args.systemDb, env: args.env, now }).catch((err) => {
    console.warn('[release-flags] background pull crashed', formatSafeError(err));
  });
}

// ─── Site choices (per tenant) ───────────────────────────────────────────────

/** Read the settings objects that hold the site's choices, uncached. */
async function readSiteSettingRows(
  db: Database,
  siteId: string,
  registry: ReadonlyMap<string, ReleaseFlagDefinition>,
): Promise<Map<string, unknown>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(and(eq(settings.siteId, siteId), inArray(settings.key, siteSettingsKeysOf(registry))));
  return new Map(rows.map((row) => [row.key, row.value]));
}

/**
 * The site's choice for every flag, keyed by flag key — from `release.flags`
 * and from the legacy settings objects (#896). Cached for 60 s under
 * `release-flags:site:v2:{siteId}`; every write path deletes or rewrites it.
 */
export async function loadSiteReleaseValues(
  db: Database,
  cache: CacheProvider | null | undefined,
  siteId: string,
  registry: ReadonlyMap<string, ReleaseFlagDefinition> = RELEASE_FLAGS,
): Promise<Record<string, unknown>> {
  const key = siteReleaseCacheKey(siteId);
  if (cache) {
    try {
      const cached = await cache.get<Record<string, unknown>>(key);
      if (cached) return asRecord(cached);
    } catch {
      // Cache outage → read the database.
    }
  }
  const values = composeSiteValues(await readSiteSettingRows(db, siteId, registry), registry);
  if (cache) {
    try {
      await cache.set(key, JSON.stringify(values), { ttl: SITE_CACHE_TTL_SECONDS });
    } catch {
      // Best effort.
    }
  }
  return values;
}

/** Drop the cached site choices, e.g. after a generic `POST /settings` write. */
export async function invalidateSiteReleaseValues(
  cache: CacheProvider | null | undefined,
  siteId: string,
): Promise<void> {
  if (!cache) return;
  try {
    await cache.delete(siteReleaseCacheKey(siteId));
  } catch (err) {
    console.warn('[release-flags] site cache delete failed; relying on TTL', formatSafeError(err));
  }
}

/**
 * Merge `changes` into the site's stored choices (`null` clears a choice).
 * Each settings object is updated by a single SQL statement — concurrent
 * writers to different fields never lose each other's choice — and legacy
 * switches (#896) are written to their original object, so the feature's own
 * reader sees the change. The result is written through to the cache, so a
 * reader that raced the write cannot leave a stale copy behind.
 */
export async function saveSiteReleaseValues(
  db: Database,
  cache: CacheProvider | null | undefined,
  siteId: string,
  changes: Readonly<Record<string, boolean | null>>,
  registry: ReadonlyMap<string, ReleaseFlagDefinition> = RELEASE_FLAGS,
): Promise<Record<string, boolean>> {
  for (const [settingsKey, { set, cleared }] of groupSiteChanges(changes, registry)) {
    const clearedArray = cleared.length
      ? sql`ARRAY[${sql.join(cleared.map((k) => sql`${k}`), sql`, `)}]::text[]`
      : sql`'{}'::text[]`;
    await db
      .insert(settings)
      .values({ siteId, key: settingsKey, value: set, scope: 'site' })
      .onConflictDoUpdate({
        target: [settings.siteId, settings.key],
        set: {
          value: sql`(CASE WHEN jsonb_typeof(${settings.value}) = 'object' THEN ${settings.value} ELSE '{}'::jsonb END - ${clearedArray}) || ${JSON.stringify(set)}::jsonb`,
          updatedAt: new Date(),
        },
      });
  }
  const stored = composeSiteValues(await readSiteSettingRows(db, siteId, registry), registry);
  const next: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === 'boolean') next[key] = value;
  }
  if (cache) {
    try {
      await cache.set(siteReleaseCacheKey(siteId), JSON.stringify(stored), { ttl: SITE_CACHE_TTL_SECONDS });
    } catch (err) {
      console.warn('[release-flags] site cache write failed; relying on TTL', formatSafeError(err));
      await invalidateSiteReleaseValues(cache, siteId);
    }
  }
  return next;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

const warnedOverrides = new Set<string>();

/** Evaluate every declared flag for one site. */
export async function evaluateReleaseFlags(args: {
  systemDb: Database;
  db: Database;
  cache: CacheProvider | null | undefined;
  siteId: string | null;
  env: ReleaseEnv;
  registry?: ReadonlyMap<string, ReleaseFlagDefinition>;
}): Promise<Map<string, ReleaseFlagState>> {
  const registry = args.registry ?? RELEASE_FLAGS;
  const { overrides, ignored } = parseReleaseFlagOverrides(args.env.LUMIBASE_RELEASE_FLAGS, registry);
  for (const entry of ignored) {
    if (warnedOverrides.has(entry)) continue;
    warnedOverrides.add(entry);
    console.warn('[release-flags] ignoring LUMIBASE_RELEASE_FLAGS entry', { entry });
  }
  const [manifest, siteValues] = await Promise.all([
    loadAcceptedManifest(args.systemDb).then((stored) => trustedAcceptedManifest(stored, args.env)),
    args.siteId ? loadSiteReleaseValues(args.db, args.cache, args.siteId, registry) : Promise.resolve({}),
  ]);
  const inputs = { envOverrides: overrides, manifestFlags: manifest?.flags ?? null, siteValues };
  const states = new Map<string, ReleaseFlagState>();
  for (const def of registry.values()) states.set(def.key, resolveReleaseFlag(def, inputs));
  return states;
}

/** Test hook: forget process-level state. */
export function resetReleaseFlagStateForTests(): void {
  resetReleaseStateForTests();
  lastPullAttemptAt = 0;
  lastPullStatus = null;
  warnedOverrides.clear();
}
