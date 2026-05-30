import { describe, expect, it } from 'vitest';
import {
  UNAVAILABLE_CAPABILITIES,
  getCapabilitiesWithFallback,
  normalizeCapabilities,
  type SetupCapabilitiesResponse,
  type SetupCapabilitiesFetchError,
} from '../use-setup-capabilities';
import type { UseQueryResult } from '@tanstack/react-query';

/**
 * Unit tests for the pure helpers in `use-setup-capabilities`. The
 * React Query wrapper itself is exercised at runtime by the wizard,
 * so we focus on the deterministic pieces:
 *
 *   - `normalizeCapabilities` covers the malformed-envelope matrix
 *     (missing fields, extra fields, wrong types) and pins the
 *     conservative-fallback policy.
 *
 *   - `getCapabilitiesWithFallback` collapses React Query's
 *     loading/error/success states into a single
 *     `SetupCapabilitiesResponse` consumers can render off of, with
 *     the safe `UNAVAILABLE_CAPABILITIES` default whenever the query
 *     hasn't produced data.
 *
 * Spec refs: requirements §6.5; design.md §4.2, §5.5.
 */

describe('normalizeCapabilities', () => {
  it('passes through a fully-populated response', () => {
    const result = normalizeCapabilities({
      geoip: { available: true, source: 'maxmind' },
      smtp: { available: true },
    });
    expect(result).toEqual({
      geoip: { available: true, source: 'maxmind' },
      smtp: { available: true },
    });
  });

  it('coerces missing capability sections to unavailable', () => {
    expect(normalizeCapabilities({})).toEqual({
      geoip: { available: false },
      smtp: { available: false },
    });
  });

  it('coerces missing `available` flags to false', () => {
    expect(normalizeCapabilities({ geoip: {}, smtp: {} })).toEqual({
      geoip: { available: false },
      smtp: { available: false },
    });
  });

  it('drops a non-maxmind source value', () => {
    // The schema currently only enumerates `'maxmind'` as a valid
    // source; anything else gets stripped so the type stays sound
    // for callers that switch on the literal.
    const result = normalizeCapabilities({
      geoip: { available: true, source: 'ip-api' },
      smtp: { available: false },
    });
    expect(result.geoip.source).toBeUndefined();
    expect(result.geoip.available).toBe(true);
  });

  it('coerces truthy `available` values via Boolean()', () => {
    // The normalizer uses `Boolean(...)` so any truthy value (even a
    // non-boolean) flips the field to `true`. The server contract
    // ships only booleans, so the only realistic non-boolean inputs
    // in the wild are `null`/`undefined`, both of which are falsy.
    // We pin the documented behaviour here rather than tightening it
    // further — over-specifying would risk a brittle test that flags
    // a benign envelope edit.
    const result = normalizeCapabilities({
      geoip: { available: 'yes' },
      smtp: { available: 1 },
    });
    expect(result.geoip.available).toBe(true);
    expect(result.smtp.available).toBe(true);
  });

  it('coerces falsy `available` values to false', () => {
    const result = normalizeCapabilities({
      geoip: { available: 0 },
      smtp: { available: '' },
    });
    expect(result.geoip.available).toBe(false);
    expect(result.smtp.available).toBe(false);
  });

  it('returns unavailable for a null body', () => {
    expect(normalizeCapabilities(null)).toEqual(UNAVAILABLE_CAPABILITIES);
  });

  it('returns unavailable for an undefined body', () => {
    expect(normalizeCapabilities(undefined)).toEqual(UNAVAILABLE_CAPABILITIES);
  });
});

// Minimal stub for `UseQueryResult`. We only exercise the three
// fields `getCapabilitiesWithFallback` reads (`data`, `isPending`,
// `isError`); the rest of the query API isn't used so we deliberately
// don't fake it.
function makeQuery(
  partial: Partial<
    UseQueryResult<SetupCapabilitiesResponse, SetupCapabilitiesFetchError>
  >,
): UseQueryResult<SetupCapabilitiesResponse, SetupCapabilitiesFetchError> {
  return partial as UseQueryResult<
    SetupCapabilitiesResponse,
    SetupCapabilitiesFetchError
  >;
}

describe('getCapabilitiesWithFallback', () => {
  it('returns query data when present', () => {
    const data: SetupCapabilitiesResponse = {
      geoip: { available: true, source: 'maxmind' },
      smtp: { available: true },
    };
    const result = getCapabilitiesWithFallback(makeQuery({ data }));
    expect(result.capabilities).toBe(data);
    expect(result.loading).toBe(false);
    expect(result.error).toBe(false);
  });

  it('falls back to UNAVAILABLE while pending', () => {
    const result = getCapabilitiesWithFallback(
      makeQuery({ data: undefined, isPending: true, isError: false }),
    );
    expect(result.capabilities).toEqual(UNAVAILABLE_CAPABILITIES);
    expect(result.loading).toBe(true);
    expect(result.error).toBe(false);
  });

  it('falls back to UNAVAILABLE on error', () => {
    const result = getCapabilitiesWithFallback(
      makeQuery({ data: undefined, isPending: false, isError: true }),
    );
    expect(result.capabilities).toEqual(UNAVAILABLE_CAPABILITIES);
    expect(result.loading).toBe(false);
    expect(result.error).toBe(true);
  });

  it('treats UNAVAILABLE_CAPABILITIES as the conservative default', () => {
    expect(UNAVAILABLE_CAPABILITIES.geoip.available).toBe(false);
    expect(UNAVAILABLE_CAPABILITIES.smtp.available).toBe(false);
  });
});
