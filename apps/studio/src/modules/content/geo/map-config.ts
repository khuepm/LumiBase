import type { FieldResource } from '@lumibase/sdk';
import type { GeoPoint } from '@lumibase/contracts/field';

/**
 * Map configuration for the geopoint input and the Map list layout (#746).
 *
 * The default style is OpenFreeMap "Liberty": free vector tiles built from
 * OpenStreetMap, no API key, no account. Its attribution ("OpenFreeMap ©
 * OpenMapTiles Data from OpenStreetMap") ships inside the style and is shown by
 * MapLibre's attribution control, which Studio always keeps on.
 *
 * Override order: the field's `options.mapStyleUrl` → the build-time
 * `VITE_MAP_STYLE_URL` → the default. Self-hosters can point it at their own
 * style (e.g. tiles served from the same origin) — anything MapLibre accepts.
 */
export const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Fallback centre when there is nothing to show yet (lng/lat, world view). */
export const WORLD_VIEW = { center: [0, 20] as [number, number], zoom: 1 };

/**
 * A style URL is accepted only over https (or http on localhost for local
 * tile servers) or as a same-origin path. Anything else — `javascript:`,
 * `data:`, plain http to a remote host — falls back to the default, so a
 * field option cannot point the map at an unexpected scheme.
 */
export function sanitizeStyleUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return url.href;
  } catch {
    return null;
  }
  return null;
}

export function resolveMapStyleUrl(field?: Pick<FieldResource, 'options'> | null, env: Record<string, unknown> = import.meta.env): string {
  return (
    sanitizeStyleUrl(field?.options?.['mapStyleUrl']) ??
    sanitizeStyleUrl(env['VITE_MAP_STYLE_URL']) ??
    DEFAULT_MAP_STYLE_URL
  );
}

/** Parse a coordinate typed by a person: finite and within ±limit, else null. */
export function parseCoordinate(text: string, limit: 90 | 180): number | null {
  const trimmed = text.trim();
  if (!trimmed || !/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= -limit && n <= limit ? n : null;
}

/** Normalise a longitude into [-180, 180] (map clicks past the antimeridian wrap). */
export function wrapLongitude(lng: number): number {
  if (lng >= -180 && lng <= 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

/** Round to 7 decimals (~1 cm) so a map click does not store float noise. */
export function roundPoint(p: GeoPoint): GeoPoint {
  const r = (n: number) => Math.round(n * 1e7) / 1e7;
  return { lat: r(p.lat), lng: r(wrapLongitude(p.lng)) };
}

export function formatPoint(p: GeoPoint): string {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}
