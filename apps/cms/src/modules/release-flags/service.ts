import { settings, systemState, type Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/contracts/utils';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { createProcessCache } from '../../services/process-cache';
import {
  MANIFEST_MAX_PAYLOAD_CHARS,
  parseReleasePublicKeys,
  releaseManifestEnvelopeSchema,
  verifyReleaseManifest,
  type ManifestRejection,
} from './manifest';
import { RELEASE_FLAGS, type ReleaseFlagDefinition } from './registry';
import { parseReleaseFlagOverrides, resolveReleaseFlag, type ReleaseFlagState } from './resolver';

/**
 * Storage and orchestration for release flags (#869).
 *
 * Resource classification (DoD §2b):
 *  - **Deployment-wide**: the accepted manifest (`lumibase_system_state`, the
 *    singleton row), the env overrides and the trusted public keys. They decide
 *    what this deployment has released and contain no tenant data.
 *  - **Per site**: each site's choices for `siteToggle` flags, stored in
 *    `lumibase_settings` (key `release.flags`, already under `site_isolation`)
 *    and cached under `release-flags:site:{siteId}`.
 */

export const SITE_RELEASE_FLAGS_KEY = 'release.flags';
const SITE_CACHE_TTL_SECONDS = 60;
const MANIFEST_CACHE_TTL_MS = 30_000;
const DEFAULT_REFRESH_SECONDS = 300;
const MIN_REFRESH_SECONDS = 60;
const PULL_TIMEOUT_MS = 5_000;

export const siteReleaseCacheKey = (siteId: string) => `release-flags:site:${siteId}`;

/** Raw environment the module reads. Strings as they come from env/bindings. */
export interface ReleaseEnv {
  readonly LUMIBASE_RELEASE_FLAGS?: string;
  readonly LUMIBASE_RELEASE_PUBLIC_KEYS?: string;
  readonly LUMIBASE_RELEASE_MANIFEST_URL?: string;
  readonly LUMIBASE_RELEASE_MANIFEST_REFRESH_S?: string;
  readonly LUMIBASE_INSTANCE_ID?: string;
}

// ─── Accepted manifest (deployment-wide) ─────────────────────────────────────

const storedManifestSchema = z.object({
  envelope: releaseManifestEnvelopeSchema,
  issuedAt: z.string(),
  issuedAtMs: z.number(),
  flags: z.record(z.string(), z.boolean()),
  acceptedAt: z.string(),
  source: z.enum(['push', 'pull']),
  acceptedBy: z.string().nullable(),
});
export type StoredManifest = z.infer<typeof storedManifestSchema>;

const manifestCache = createProcessCache<StoredManifest | null>({ ttlMs: MANIFEST_CACHE_TTL_MS });

/**
 * The manifest this deployment accepted, or `null`. Cached per process for
 * 30 s: another replica that accepts a manifest is picked up within that
 * window; the replica that accepted it clears its own cache immediately.
 * A read failure answers `null` for this call only (not cached), so flags fall
 * back to stage defaults rather than failing the request.
 */
export async function loadAcceptedManifest(systemDb: Database): Promise<StoredManifest | null> {
  try {
    return await manifestCache.get(async () => {
      const [row] = await systemDb
        .select({ manifest: systemState.releaseManifest })
        .from(systemState)
        .where(eq(systemState.id, 'singleton'))
        .limit(1);
      const parsed = storedManifestSchema.safeParse(row?.manifest);
      return parsed.success ? parsed.data : null;
    });
  } catch (err) {
    console.warn('[release-flags] could not read the accepted manifest', formatSafeError(err));
    return null;
  }
}

export type AcceptOutcome =
  | { ok: true; unchanged: boolean; manifest: StoredManifest; unknownKeys: string[] }
  | { ok: false; reason: ManifestRejection | 'KEYS_NOT_CONFIGURED' | 'NOT_INITIALIZED' };

/**
 * Verify `input` and, when it is newer than the stored one, persist it. The
 * write is a conditional UPDATE (`issuedAtMs` strictly greater), so two
 * replicas pulling at once, or a replay racing a fresh manifest, cannot store
 * an older manifest over a newer one.
 */
export async function acceptReleaseManifest(args: {
  systemDb: Database;
  env: ReleaseEnv;
  input: unknown;
  source: 'push' | 'pull';
  actorUserId: string | null;
  now?: number;
  registry?: ReadonlyMap<string, ReleaseFlagDefinition>;
}): Promise<AcceptOutcome> {
  const publicKeys = parseReleasePublicKeys(args.env.LUMIBASE_RELEASE_PUBLIC_KEYS);
  if (Object.keys(publicKeys).length === 0) return { ok: false, reason: 'KEYS_NOT_CONFIGURED' };

  manifestCache.clear();
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
  const updated = await args.systemDb
    .update(systemState)
    .set({ releaseManifest: record, updatedAt: new Date(now) })
    .where(
      and(
        eq(systemState.id, 'singleton'),
        sql`(${systemState.releaseManifest} IS NULL OR (${systemState.releaseManifest}->>'issuedAtMs')::bigint < ${record.issuedAtMs})`,
      ),
    )
    .returning({ id: systemState.id });
  manifestCache.clear();

  if (updated.length === 0) {
    const [exists] = await args.systemDb
      .select({ id: systemState.id })
      .from(systemState)
      .where(eq(systemState.id, 'singleton'))
      .limit(1);
    return { ok: false, reason: exists ? 'STALE' : 'NOT_INITIALIZED' };
  }
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
    const res = await (args.fetchImpl ?? fetch)(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
    });
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function loadSiteReleaseValues(
  db: Database,
  cache: CacheProvider | null | undefined,
  siteId: string,
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
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, SITE_RELEASE_FLAGS_KEY)))
    .limit(1);
  const values = asRecord(row?.value);
  if (cache) {
    try {
      await cache.set(key, JSON.stringify(values), { ttl: SITE_CACHE_TTL_SECONDS });
    } catch {
      // Best effort.
    }
  }
  return values;
}

/**
 * Merge `changes` into the site's stored choices (`null` clears a choice) and
 * drop the cached copy so the next evaluation reads the new value.
 */
export async function saveSiteReleaseValues(
  db: Database,
  cache: CacheProvider | null | undefined,
  siteId: string,
  changes: Readonly<Record<string, boolean | null>>,
): Promise<Record<string, boolean>> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, SITE_RELEASE_FLAGS_KEY)))
    .limit(1);
  const next: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(asRecord(row?.value))) {
    if (typeof value === 'boolean') next[key] = value;
  }
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  await db
    .insert(settings)
    .values({ siteId, key: SITE_RELEASE_FLAGS_KEY, value: next, scope: 'site' })
    .onConflictDoUpdate({
      target: [settings.siteId, settings.key],
      set: { value: next, updatedAt: new Date() },
    });
  if (cache) {
    try {
      await cache.delete(siteReleaseCacheKey(siteId));
    } catch (err) {
      console.warn('[release-flags] site cache delete failed; relying on TTL', formatSafeError(err));
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
    loadAcceptedManifest(args.systemDb),
    args.siteId ? loadSiteReleaseValues(args.db, args.cache, args.siteId) : Promise.resolve({}),
  ]);
  const inputs = { envOverrides: overrides, manifestFlags: manifest?.flags ?? null, siteValues };
  const states = new Map<string, ReleaseFlagState>();
  for (const def of registry.values()) states.set(def.key, resolveReleaseFlag(def, inputs));
  return states;
}

/** Test hook: forget process-level state. */
export function resetReleaseFlagStateForTests(): void {
  manifestCache.clear();
  lastPullAttemptAt = 0;
  lastPullStatus = null;
  warnedOverrides.clear();
}
