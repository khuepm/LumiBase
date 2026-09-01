import { useQuery, type UseQueryResult } from '@tanstack/react-query';

/**
 * React Query hook that fetches `GET /api/v1/setup/capabilities`
 * (design §4.2).
 *
 * The endpoint reports two ambient capabilities the wizard cares
 * about while configuring login security:
 *
 *   - `geoip.available` — whether a GeoIP MMDB file is loaded on the
 *     CMS, so the form can warn the operator that ticking
 *     `geoAnomalyEnabled` will be a no-op until the file ships
 *     (Req 6.5).
 *   - `smtp.available` — whether email notifications can actually
 *     leave the instance. Surfaced by the wizard's Notifications group
 *     in a future task; included in the response shape for forward
 *     compatibility.
 *
 * The endpoint returns 404 once the instance is initialized
 * (design §4.2). `SetupStateGate` already guards every wizard route
 * against rendering when state is `'initialized'`, so within the
 * wizard's lifetime this query is expected to succeed; a 404 here
 * surfaces as a `SetupCapabilitiesFetchError` and the caller falls
 * back to the safe default ("treat capabilities as unavailable").
 *
 * Spec refs: requirements §6.5, §12.4; design.md §4.2, §5.5.
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface SetupCapabilitiesResponse {
  readonly geoip: {
    readonly available: boolean;
    readonly source?: 'maxmind';
  };
  readonly smtp: {
    readonly available: boolean;
  };
  /**
   * `encryption.available` — whether the CMS can resolve an AEAD key
   * (`ENCRYPTION_KEY` / `ENCRYPTION_KEY_<id>`, directly or via `*_FILE`).
   * Without one, TOTP two-factor enrollment and encrypted item fields are
   * unavailable, so the wizard says so here rather than letting the operator
   * find out from a `503` the first time someone opens Settings → Security.
   */
  readonly encryption: {
    readonly available: boolean;
  };
}

/**
 * Error subtype thrown by the fetcher so consumers can distinguish
 * fetch/parse failures from React Query's generic `Error`. Carries the
 * HTTP status when known.
 */
export class SetupCapabilitiesFetchError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SetupCapabilitiesFetchError';
    this.status = status;
  }
}

// ── Fetcher ──────────────────────────────────────────────────────────────

/**
 * GET `/api/v1/setup/capabilities` and validate the response shape.
 *
 * Validation is deliberately permissive: missing fields default to
 * `available: false` so a partial server response surfaces as "no
 * capability" rather than a hard error. That keeps the wizard's
 * GeoIP warning conservative — operators see the warning when in
 * doubt rather than silently believing GeoIP is available.
 */
async function fetchSetupCapabilities(): Promise<SetupCapabilitiesResponse> {
  let res: Response;
  try {
    res = await fetch('/api/v1/setup/capabilities', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new SetupCapabilitiesFetchError('network');
  }

  if (!res.ok) {
    throw new SetupCapabilitiesFetchError(`http ${res.status}`, res.status);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SetupCapabilitiesFetchError('malformed');
  }

  return normalizeCapabilities(body);
}

/**
 * Pure normalizer extracted so it can be unit-tested against the full
 * envelope matrix without a fetch mock. Exported because the hook's
 * test suite exercises it directly.
 */
export function normalizeCapabilities(value: unknown): SetupCapabilitiesResponse {
  // Treat the input as a plain record of `unknown` keys — `Partial`
  // would force readers to assert each field's type below, and the
  // server contract isn't strict enough about extra fields to make
  // that worthwhile.
  const obj = (value && typeof value === 'object' ? value : {}) as Record<
    string,
    unknown
  >;
  const geoip =
    obj.geoip && typeof obj.geoip === 'object'
      ? (obj.geoip as Record<string, unknown>)
      : {};
  const smtp =
    obj.smtp && typeof obj.smtp === 'object'
      ? (obj.smtp as Record<string, unknown>)
      : {};
  const encryption =
    obj.encryption && typeof obj.encryption === 'object'
      ? (obj.encryption as Record<string, unknown>)
      : {};
  const result: SetupCapabilitiesResponse = {
    geoip: {
      available: Boolean(geoip.available),
      ...(geoip.source === 'maxmind' ? { source: 'maxmind' as const } : {}),
    },
    smtp: {
      available: Boolean(smtp.available),
    },
    encryption: {
      // Absent → assume available, unlike `geoip`/`smtp`. Studio and the CMS
      // can be deployed separately (Pages vs Workers), so an older CMS that
      // does not report this field must not make the wizard announce that 2FA
      // is impossible. Only an explicit `false` raises the notice.
      available: encryption.available === undefined ? true : Boolean(encryption.available),
    },
  };
  return result;
}

// ── Hook ─────────────────────────────────────────────────────────────────

/**
 * React Query wrapper for `GET /api/v1/setup/capabilities`.
 *
 * Cache settings:
 *
 *   - `staleTime: Infinity` — capabilities are baked into the running
 *     CMS process (filesystem probe + env vars) and don't change
 *     without a restart. Refetching on every step navigation would be
 *     wasteful and could briefly flip the GeoIP warning off/on
 *     depending on network jitter.
 *   - `retry: 1` — one retry softens transient network blips while
 *     keeping the wizard responsive. The fallback below means even a
 *     hard error doesn't block submit.
 *
 * Failure semantics: when the query is in error state, callers should
 * treat capabilities as `{ available: false }` for both GeoIP and
 * SMTP. The dedicated helper `getCapabilitiesWithFallback` below
 * encodes that policy so consumers don't have to repeat the safe-
 * default each call site.
 */
export function useSetupCapabilities(): UseQueryResult<
  SetupCapabilitiesResponse,
  SetupCapabilitiesFetchError
> {
  return useQuery<SetupCapabilitiesResponse, SetupCapabilitiesFetchError>({
    queryKey: ['setup', 'capabilities'],
    queryFn: fetchSetupCapabilities,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

/**
 * Conservative fallback used when the query result is unavailable
 * (loading or error). Treats every probe as unavailable so the
 * wizard's GeoIP warning surfaces in any uncertain state — better to
 * over-warn an operator who has GeoIP installed than to silently let
 * them assume coverage that isn't there.
 */
export const UNAVAILABLE_CAPABILITIES: SetupCapabilitiesResponse = Object.freeze({
  geoip: { available: false },
  smtp: { available: false },
  // `encryption` is the one probe where the conservative default is "available".
  // The others gate a warning, so guessing "unavailable" over-warns harmlessly;
  // this one would claim a working deployment cannot do 2FA whenever the probe
  // itself fails, which is both wrong and alarming.
  encryption: { available: true },
});

/**
 * Resolve a query result into a definite `SetupCapabilitiesResponse`.
 * `loading: true` while the query hasn't settled; `error: true` when
 * the fetch failed (after retries) — both states fall back to
 * `UNAVAILABLE_CAPABILITIES`.
 */
export function getCapabilitiesWithFallback(
  query: UseQueryResult<SetupCapabilitiesResponse, SetupCapabilitiesFetchError>,
): {
  capabilities: SetupCapabilitiesResponse;
  loading: boolean;
  error: boolean;
} {
  if (query.data !== undefined) {
    return {
      capabilities: query.data,
      loading: false,
      error: false,
    };
  }
  return {
    capabilities: UNAVAILABLE_CAPABILITIES,
    loading: query.isPending,
    error: query.isError,
  };
}
