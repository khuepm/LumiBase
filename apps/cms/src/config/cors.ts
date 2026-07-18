import type { Bindings } from '../env';

export function parseAllowedOrigins(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Local development origins we implicitly trust when no explicit allowlist is
 * configured. Kept narrow: only loopback hosts, any port/scheme.
 */
function isLocalDevOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
}

/**
 * Resolve the value for the `Access-Control-Allow-Origin` header.
 *
 * The CMS always sends credentialed CORS responses (`credentials: true`), so we
 * must NEVER return `*` and must never reflect an arbitrary internet origin —
 * doing so would let any site make credentialed cross-origin requests
 * (CWE-942). Rules:
 *   - An explicit `CORS_ALLOWED_ORIGINS` allowlist is honored in every
 *     environment (exact match only; `*` in the list is ignored for
 *     credentialed responses).
 *   - With no allowlist, outside production we reflect only loopback origins so
 *     local dev works; everything else (including production) is denied.
 */
export function resolveCorsOrigin(
  requestOrigin: string | undefined,
  env: Pick<Bindings, 'CORS_ALLOWED_ORIGINS' | 'LUMIBASE_ENV'>,
): string | undefined {
  if (!requestOrigin) return undefined;

  const allowedOrigins = parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS).filter(
    (o) => o !== '*',
  );

  if (allowedOrigins.includes(requestOrigin)) return requestOrigin;

  // No explicit match: allow only loopback origins, and only outside production.
  if (env.LUMIBASE_ENV !== 'production' && isLocalDevOrigin(requestOrigin)) {
    return requestOrigin;
  }

  return undefined;
}
