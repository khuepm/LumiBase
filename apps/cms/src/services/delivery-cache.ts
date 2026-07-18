/**
 * Delivery HTTP-cache helpers (high-load-cache-readiness Req 1; design §3,
 * §15.4).
 *
 * The Delivery API is the hottest read path under load. These helpers let the
 * route emit correct HTTP caching metadata so any standard CDN / proxy /
 * browser can absorb repeat reads without origin work:
 *
 *  - {@link resolveDeliveryCachePolicy} — classifies a request as publicly
 *    cacheable (published content, no credentials) vs private (`no-store`).
 *  - {@link weakEtag} — deterministic weak ETag from cheap fingerprint inputs.
 *  - {@link etagMatches} — RFC 9110 §8.8.3 weak comparison for
 *    `If-None-Match`, so revalidation requests can be answered with 304.
 */

const DEFAULT_SMAXAGE_SECONDS = 60;
const DEFAULT_SWR_SECONDS = 300;

export interface DeliveryCacheEnv {
  /** Shared-cache lifetime in seconds. `0` disables public caching entirely. */
  LUMIBASE_DELIVER_SMAXAGE?: string;
  /** stale-while-revalidate window in seconds. */
  LUMIBASE_DELIVER_SWR?: string;
}

export interface DeliveryCachePolicy {
  /** True when the response may be stored by shared intermediary caches. */
  cacheable: boolean;
  /** Value for the `Cache-Control` response header. */
  cacheControl: string;
}

/**
 * Decide the cache posture for a delivery request. Requests carrying
 * credentials must never produce a shared-cacheable response (Req 1.4): the
 * payload could differ per principal once preview/draft delivery lands.
 */
export function resolveDeliveryCachePolicy(options: {
  hasCredentials: boolean;
  env?: DeliveryCacheEnv;
}): DeliveryCachePolicy {
  if (options.hasCredentials) {
    return { cacheable: false, cacheControl: 'private, no-store' };
  }
  const sMaxAge = parseSeconds(
    options.env?.LUMIBASE_DELIVER_SMAXAGE ?? processEnv('LUMIBASE_DELIVER_SMAXAGE'),
    DEFAULT_SMAXAGE_SECONDS,
  );
  if (sMaxAge === 0) {
    return { cacheable: false, cacheControl: 'private, no-store' };
  }
  const swr = parseSeconds(
    options.env?.LUMIBASE_DELIVER_SWR ?? processEnv('LUMIBASE_DELIVER_SWR'),
    DEFAULT_SWR_SECONDS,
  );
  return {
    cacheable: true,
    cacheControl: `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`,
  };
}

/**
 * Weak ETag over an ordered list of fingerprint inputs. Weak (`W/`) because
 * the tag asserts semantic equivalence of the payload, not byte identity —
 * the JSON body is never buffered to compute it.
 */
export async function weakEtag(
  parts: ReadonlyArray<string | number | boolean | Date | null | undefined>,
): Promise<string> {
  const input = parts
    .map((part) => (part instanceof Date ? part.toISOString() : String(part ?? '')))
    .join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `W/"${hex.slice(0, 32)}"`;
}

/** RFC 9110 §8.8.3 weak comparison against an `If-None-Match` header value. */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const target = opaqueTag(etag);
  return ifNoneMatch
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || opaqueTag(candidate) === target);
}

/** Weak comparison ignores the `W/` prefix on both sides. */
function opaqueTag(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

function processEnv(key: string): string | undefined {
  return typeof process !== 'undefined' ? process.env?.[key] : undefined;
}

function parseSeconds(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}
