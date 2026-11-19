import type { CacheProvider } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/contracts/utils';
import {
  releaseManifestConsecutiveFailures,
  releaseManifestLastSuccess,
  releaseManifestPullsTotal,
} from '../../routes/metrics';

/**
 * Deployment-wide record of release-manifest pulls (#897).
 *
 * Kept in the runtime cache (Redis on Docker, KV on Workers) rather than in
 * process memory, so every replica and isolate reports the same history in
 * `/health` and so the scheduled pull can tell whether *any* replica pulled
 * recently. Best effort: a cache outage only loses the history, never a
 * manifest — the accepted manifest itself lives in the database.
 */

export const PULL_STATUS_CACHE_KEY = 'release-flags:pull-status';
/** Long enough to outlive any refresh interval; refreshed on every attempt. */
const PULL_STATUS_TTL_SECONDS = 30 * 24 * 3600;

export interface ReleasePullHealth {
  /** Last pull attempt (any outcome). */
  readonly lastAttemptAt: string | null;
  /** Last pull that fetched and verified a manifest (new or unchanged). */
  readonly lastSuccessAt: string | null;
  /** `issuedAt` of the manifest this deployment accepted last (pull or push). */
  readonly acceptedIssuedAt: string | null;
  /** Failed pulls since the last success. */
  readonly consecutiveFailures: number;
  /** Reason of the last failure, cleared by a success. */
  readonly lastError: string | null;
}

export const EMPTY_PULL_HEALTH: ReleasePullHealth = Object.freeze({
  lastAttemptAt: null,
  lastSuccessAt: null,
  acceptedIssuedAt: null,
  consecutiveFailures: 0,
  lastError: null,
});

function parse(value: unknown): ReleasePullHealth {
  const raw = (typeof value === 'string' ? safeJson(value) : value) as Partial<ReleasePullHealth> | null;
  if (!raw || typeof raw !== 'object') return EMPTY_PULL_HEALTH;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    lastAttemptAt: str(raw.lastAttemptAt),
    lastSuccessAt: str(raw.lastSuccessAt),
    acceptedIssuedAt: str(raw.acceptedIssuedAt),
    consecutiveFailures:
      typeof raw.consecutiveFailures === 'number' && raw.consecutiveFailures >= 0 ? raw.consecutiveFailures : 0,
    lastError: str(raw.lastError),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function readPullHealth(cache: CacheProvider | null | undefined): Promise<ReleasePullHealth> {
  if (!cache) return EMPTY_PULL_HEALTH;
  try {
    return parse(await cache.get<unknown>(PULL_STATUS_CACHE_KEY));
  } catch {
    return EMPTY_PULL_HEALTH;
  }
}

async function write(cache: CacheProvider, next: ReleasePullHealth): Promise<void> {
  try {
    await cache.set(PULL_STATUS_CACHE_KEY, JSON.stringify(next), { ttl: PULL_STATUS_TTL_SECONDS });
  } catch (err) {
    console.warn('[release-flags] could not record the pull status', formatSafeError(err));
  }
}

export type PullRecord =
  | { readonly ok: true; readonly unchanged: boolean; readonly issuedAt: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Record one pull attempt: metrics in this process, history in the shared
 * cache. Read-modify-write — two replicas finishing at the same instant can
 * lose one increment of `consecutiveFailures`, which only delays an alert by
 * one interval.
 */
export async function recordPullAttempt(
  cache: CacheProvider | null | undefined,
  outcome: PullRecord,
  at: number,
): Promise<ReleasePullHealth> {
  releaseManifestPullsTotal.inc({ outcome: outcome.ok ? (outcome.unchanged ? 'unchanged' : 'accepted') : 'failed' });
  const previous = await readPullHealth(cache);
  const iso = new Date(at).toISOString();
  const next: ReleasePullHealth = outcome.ok
    ? {
        lastAttemptAt: iso,
        lastSuccessAt: iso,
        acceptedIssuedAt: outcome.issuedAt,
        consecutiveFailures: 0,
        lastError: null,
      }
    : {
        ...previous,
        lastAttemptAt: iso,
        consecutiveFailures: previous.consecutiveFailures + 1,
        lastError: outcome.reason,
      };
  releaseManifestConsecutiveFailures.set(next.consecutiveFailures);
  if (outcome.ok) releaseManifestLastSuccess.set(Math.floor(at / 1000));
  if (cache) await write(cache, next);
  return next;
}

/** A manifest was accepted outside a pull (push through the API). */
export async function recordAcceptedManifest(
  cache: CacheProvider | null | undefined,
  issuedAt: string,
): Promise<void> {
  if (!cache) return;
  const previous = await readPullHealth(cache);
  await write(cache, { ...previous, acceptedIssuedAt: issuedAt });
}
