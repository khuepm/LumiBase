/**
 * Shard Config — POST-GA Task #5.
 *
 * Configuration and utilities for multi-region Durable Objects sharding.
 * Maps Cloudflare colos to region hints and provides shard key generation.
 *
 * On Docker runtime, this falls back to single-instance (no sharding).
 */

// ---------------------------------------------------------------------------
// Region types
// ---------------------------------------------------------------------------

export type RegionHint = 'wnam' | 'enam' | 'weur' | 'eeur' | 'apac';

export const REGION_HINTS: RegionHint[] = ['wnam', 'enam', 'weur', 'eeur', 'apac'];

/**
 * Map Cloudflare 3-letter IATA colo codes to region hints.
 * This is a subset — Cloudflare has 300+ colos; we group them by broad region.
 */
const COLO_TO_REGION: Record<string, RegionHint> = {
  // Western North America
  LAX: 'wnam', SFO: 'wnam', SEA: 'wnam', DEN: 'wnam', PHX: 'wnam',
  SJC: 'wnam', PDX: 'wnam', LAS: 'wnam', SLC: 'wnam', YVR: 'wnam',
  // Eastern North America
  IAD: 'enam', EWR: 'enam', ORD: 'enam', ATL: 'enam', MIA: 'enam',
  DFW: 'enam', IAH: 'enam', MSP: 'enam', DTW: 'enam', BOS: 'enam',
  JFK: 'enam', CLT: 'enam', PHL: 'enam', YYZ: 'enam', YUL: 'enam',
  // Western Europe
  LHR: 'weur', CDG: 'weur', AMS: 'weur', FRA: 'weur', MAD: 'weur',
  LIS: 'weur', DUB: 'weur', MAN: 'weur', ZRH: 'weur', BRU: 'weur',
  MXP: 'weur', FCO: 'weur', BCN: 'weur',
  // Eastern Europe
  WAW: 'eeur', PRG: 'eeur', BUD: 'eeur', VIE: 'eeur', SOF: 'eeur',
  OTP: 'eeur', HEL: 'eeur', ARN: 'eeur', CPH: 'eeur', OSL: 'eeur',
  IST: 'eeur', TLV: 'eeur',
  // Asia-Pacific
  NRT: 'apac', HND: 'apac', KIX: 'apac', ICN: 'apac', HKG: 'apac',
  SIN: 'apac', BOM: 'apac', DEL: 'apac', SYD: 'apac', MEL: 'apac',
  BKK: 'apac', SGN: 'apac', HAN: 'apac', TPE: 'apac', MNL: 'apac',
  CGK: 'apac', KUL: 'apac',
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Derives a region hint from a Cloudflare colo code.
 * Falls back to 'enam' (US East) if colo is unknown.
 */
export function getRegionFromColo(colo?: string): RegionHint {
  if (!colo) return 'enam';
  return COLO_TO_REGION[colo.toUpperCase()] ?? 'enam';
}

/**
 * Generates a shard key for Durable Object routing.
 * Format: `{siteId}:{region}`
 */
export function getShardKey(siteId: string, region: RegionHint): string {
  return `${siteId}:${region}`;
}

/**
 * Gets the appropriate location hint for a Durable Object stub.
 * Only applicable on Cloudflare runtime — returns undefined on Docker.
 */
export function getLocationHint(
  runtime: string | undefined,
  colo: string | undefined,
): RegionHint | undefined {
  if (runtime !== 'cloudflare') {
    return undefined; // Docker mode — no location hints
  }
  return getRegionFromColo(colo);
}

/**
 * Checks if the runtime supports multi-region DO sharding.
 */
export function isShardingSupported(runtime: string | undefined): boolean {
  return runtime === 'cloudflare';
}

// ---------------------------------------------------------------------------
// Plane-aware room resolution (realtime-audience-channels)
// ---------------------------------------------------------------------------

export type RealtimePlane = 'studio' | 'public';

/**
 * Deterministic bucket for a subject within the audience plane. Cheap FNV-1a
 * hash — the connect path and the publish path MUST call this identically so a
 * subject's connections and the events targeting them land on the same room.
 */
export function subjectBucket(subjectId: string, buckets: number): number {
  if (buckets <= 1) return 0;
  let h = 0x811c9dc5;
  for (let i = 0; i < subjectId.length; i++) {
    h ^= subjectId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % buckets;
}

export interface RoomNameOptions {
  /** Realtime plane. Defaults to `studio` for backward compatibility. */
  plane?: RealtimePlane;
  /** Region hint (studio multi-region). Ignored for audience buckets. */
  region?: RegionHint;
  /**
   * Subject id — required to derive an audience bucket when `buckets > 1`.
   * Publish paths that target a channel (no subject) must pass the same
   * `bucket` value the connecting sessions used, or set `buckets = 1`.
   */
  subjectId?: string;
  /** Explicit audience bucket, overrides `subjectId` hashing when provided. */
  bucket?: number;
  /** Number of audience buckets per site. `1` (default) = single room. */
  buckets?: number;
}

/**
 * Single source of truth for the Durable Object / hub room name. Used by BOTH
 * the WS upgrade route (connect) and the publish path so they never diverge.
 *
 * - studio:   `{siteId}` or `{siteId}:{region}` (existing behaviour)
 * - public:   `{siteId}:aud` or `{siteId}:aud:{bucket}`
 */
export function resolveRoomName(siteId: string, opts: RoomNameOptions = {}): string {
  const plane = opts.plane ?? 'studio';

  if (plane === 'public') {
    const buckets = opts.buckets ?? 1;
    if (buckets <= 1) return `${siteId}:aud`;
    const bucket =
      opts.bucket ?? (opts.subjectId ? subjectBucket(opts.subjectId, buckets) : 0);
    return `${siteId}:aud:${bucket}`;
  }

  // studio plane — preserve legacy shard keys
  return opts.region ? getShardKey(siteId, opts.region) : siteId;
}
