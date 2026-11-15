/**
 * `geopoint` field type (#746). A single WGS 84 position stored in the item's
 * JSON as `{ "lat": <number>, "lng": <number> }`. Every array form (bbox,
 * GeoJSON coordinates) is longitude-first, as in GeoJSON and PostGIS.
 *
 * Shared by the CMS (write validation, filter parsing), Studio (map input) and
 * the SDK (`GeoPoint` type), so the three cannot disagree on what a valid
 * point is. Kept zod-free like the rest of `@lumibase/contracts/field`; the
 * zod schemas live in `schemas/geopoint.ts`.
 */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** `[minLng, minLat, maxLng, maxLat]`; `minLng > maxLng` crosses the antimeridian. */
export type GeoBBox = [number, number, number, number];

/** `_near` operand: a centre plus a radius in metres. */
export interface GeoNear {
  lat: number;
  lng: number;
  radius: number;
}

/**
 * Mean Earth radius in metres. PostGIS uses the same value for geography
 * calculations on the sphere (`use_spheroid => false`), which is what lets the
 * SQL-only haversine path and the PostGIS path return the same rows.
 */
export const EARTH_RADIUS_M = 6371008.7714;

/** Largest radius `_near` accepts: half the circumference (the antipode). */
export const GEO_MAX_RADIUS_M = Math.PI * EARTH_RADIUS_M;

/** Narrowing helper: exactly `{ lat, lng }`, finite and in range. */
export function isGeoPoint(value: unknown): value is GeoPoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('lat') || !keys.includes('lng')) return false;
  const { lat, lng } = value as Record<string, unknown>;
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres (haversine on a sphere of
 * {@link EARTH_RADIUS_M}). The SQL fallback evaluates the same formula.
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h))));
}

/** Whether `p` lies inside `bbox` (inclusive), honouring antimeridian wrap. */
export function bboxContains(bbox: GeoBBox, p: GeoPoint): boolean {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  if (p.lat < minLat || p.lat > maxLat) return false;
  return minLng <= maxLng ? p.lng >= minLng && p.lng <= maxLng : p.lng >= minLng || p.lng <= maxLng;
}
