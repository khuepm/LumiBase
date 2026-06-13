import { beforeEach, describe, it, expect, vi } from 'vitest';

const maxmindOpenMock = vi.hoisted(() => vi.fn());

vi.mock('maxmind', () => ({
  open: maxmindOpenMock,
}));

import {
  DEFAULT_TIMEOUT_MS,
  GEO_TIMEOUT_ERROR_MESSAGE,
  createGeoSubscore,
  createMmdbLookup,
  withTimeout,
} from '../geo';
import type {
  GeoBaselineSnapshot,
  LoginAttemptDraft,
} from '../types';

/**
 * Unit tests for the geo subscore (admin-setup-wizard task 7.2;
 * Req 9.1–9.6; design §8.1).
 *
 * The detector is exercised through {@link createGeoSubscore} with
 * stub `lookup` and `loadBaseline` implementations so the tests
 * never touch a real MMDB file or DB connection. Each `describe`
 * block targets one acceptance criterion from Req 9 so the trace is
 * easy to follow:
 *
 *   - 9.1 — 2 s timeout via Promise wrapper.
 *   - 9.2 — country code not in baseline ⇒ subscore = 1.
 *   - 9.3 — country code in baseline ⇒ subscore = 0.
 *   - 9.4 — `successfulLogins < 3` ⇒ baseline warmup.
 *   - 9.5 — RFC1918/loopback IPs ⇒ status `'unavailable'`, subscore 0.
 *   - 9.6 — baseline cap is the writer's job, but the reader must
 *           tolerate any list size; we cover the read side here.
 *
 * The Database handle is irrelevant because `loadBaseline` is
 * stubbed; we cast `null` for clarity in the test body.
 */

const NULL_DB = null as unknown as Parameters<typeof createGeoSubscore>[0];

beforeEach(() => {
  maxmindOpenMock.mockReset();
});

function makeBaselineLoader(
  baselines: Record<string, GeoBaselineSnapshot | null>,
): (userId: string) => Promise<GeoBaselineSnapshot | null> {
  return async (userId) => baselines[userId] ?? null;
}

function makeLookup(
  table: Record<string, string | null>,
  options?: { available?: boolean; delayMs?: number; throws?: Error },
) {
  return {
    available: () => options?.available ?? true,
    lookupCountry: vi.fn(async (ip: string) => {
      if (options?.throws) throw options.throws;
      if (options?.delayMs && options.delayMs > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, options.delayMs),
        );
      }
      return table[ip] ?? null;
    }),
  };
}

// ── MMDB lazy loading regression ────────────────────────────────────────

describe('createMmdbLookup — lazy loading', () => {
  it('reports available before first load so the detector initializes the MMDB reader', async () => {
    maxmindOpenMock.mockResolvedValue({
      get: vi.fn(() => ({ country: { iso_code: 'US' } })),
    });

    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['VN'], successfulLogins: 10 },
      }),
      mmdbPath: 'test-lazy-load-country.mmdb',
    });
    const attempt: LoginAttemptDraft = {};

    const result = await subscore('u1', '8.8.8.8', attempt);

    expect(maxmindOpenMock).toHaveBeenCalledWith('test-lazy-load-country.mmdb');
    expect(result).toEqual({ value: 1, baselineWarmup: false });
    expect(attempt.countryCode).toBe('US');
    expect(attempt.geoLookupStatus).toBe('ok');
  });

  it('reports unavailable after a failed load has completed', async () => {
    maxmindOpenMock.mockResolvedValue(null);
    const lookup = createMmdbLookup('test-lazy-load-missing.mmdb');

    expect(lookup.available()).toBe(true);
    await expect(lookup.lookupCountry('8.8.8.8')).resolves.toBeNull();
    expect(lookup.available()).toBe(false);
  });
});

// ── Req 9.5: private/loopback skip ──────────────────────────────────────

describe('geoSubscore — private/loopback IPs (Req 9.5)', () => {
  it('skips MMDB lookup for loopback and tags status unavailable', async () => {
    const lookup = makeLookup({});
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['US'], successfulLogins: 5 },
      }),
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '127.0.0.1', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.geoLookupStatus).toBe('unavailable');
    expect(attempt.countryCode).toBeNull();
    expect(lookup.lookupCountry).not.toHaveBeenCalled();
  });

  it('skips MMDB lookup for RFC1918', async () => {
    const lookup = makeLookup({});
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['US'], successfulLogins: 5 },
      }),
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '10.0.0.5', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.geoLookupStatus).toBe('unavailable');
    expect(lookup.lookupCountry).not.toHaveBeenCalled();
  });

  it('skips MMDB lookup for the unknown sentinel', async () => {
    const lookup = makeLookup({});
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({}),
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', 'unknown', attempt);
    // No baseline + private → warmup mode applies.
    expect(result).toEqual({ value: 0, baselineWarmup: true });
    expect(attempt.geoLookupStatus).toBe('unavailable');
    expect(lookup.lookupCountry).not.toHaveBeenCalled();
  });
});

// ── Req 9.4: warmup ─────────────────────────────────────────────────────

describe('geoSubscore — baseline warmup (Req 9.4)', () => {
  it('returns warmup=true when successfulLogins < 3, even on country mismatch', async () => {
    const lookup = makeLookup({ '8.8.8.8': 'US' });
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['VN'], successfulLogins: 2 },
      }),
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '8.8.8.8', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: true });
    // Country still recorded for audit purposes.
    expect(attempt.countryCode).toBe('US');
    expect(attempt.geoLookupStatus).toBe('ok');
  });

  it('returns warmup=true when there is no baseline row yet', async () => {
    const lookup = makeLookup({ '8.8.8.8': 'US' });
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({}),
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('first-time-user', '8.8.8.8', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: true });
  });

  it('exits warmup at successfulLogins=3', async () => {
    const lookup = makeLookup({ '8.8.8.8': 'US' });
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['US'], successfulLogins: 3 },
      }),
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '8.8.8.8', attempt);
    expect(result.baselineWarmup).toBe(false);
  });
});

// ── Req 9.2 / 9.3: country mismatch / match ────────────────────────────

describe('geoSubscore — country comparison (Req 9.2, 9.3)', () => {
  it('subscore=1 when country not in baseline', async () => {
    const lookup = makeLookup({ '8.8.8.8': 'US' });
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['VN', 'JP'], successfulLogins: 10 },
      }),
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '8.8.8.8', attempt);
    expect(result).toEqual({ value: 1, baselineWarmup: false });
    expect(attempt.countryCode).toBe('US');
    expect(attempt.geoLookupStatus).toBe('ok');
  });

  it('subscore=0 when country present in baseline', async () => {
    const lookup = makeLookup({ '203.0.113.5': 'VN' });
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['VN', 'JP'], successfulLogins: 10 },
      }),
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '203.0.113.5', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.countryCode).toBe('VN');
  });

  it('subscore=0 with status=unavailable when MMDB has no record', async () => {
    const lookup = makeLookup({});
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['US'], successfulLogins: 10 },
      }),
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '203.0.113.5', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.geoLookupStatus).toBe('unavailable');
    expect(attempt.countryCode).toBeNull();
  });

  it('subscore=0 when lookup is unavailable (no MMDB loaded)', async () => {
    const lookup = makeLookup({}, { available: false });
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['US'], successfulLogins: 10 },
      }),
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '8.8.8.8', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.geoLookupStatus).toBe('unavailable');
    expect(lookup.lookupCountry).not.toHaveBeenCalled();
  });
});

// ── Req 9.1: timeout wrapper ────────────────────────────────────────────

describe('geoSubscore — timeout (Req 9.1)', () => {
  it('returns 0 with status=timeout when lookup exceeds timeoutMs', async () => {
    const lookup = makeLookup({ '8.8.8.8': 'US' }, { delayMs: 50 });
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['US'], successfulLogins: 10 },
      }),
      lookup,
      timeoutMs: 5,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '8.8.8.8', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.geoLookupStatus).toBe('timeout');
  });

  it('returns 0 with status=unavailable when lookup throws a non-timeout error', async () => {
    const lookup = makeLookup(
      {},
      { throws: new Error('mmdb file corrupted') },
    );
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: makeBaselineLoader({
        u1: { countries: ['US'], successfulLogins: 10 },
      }),
      lookup,
      timeoutMs: 5_000,
    });
    const attempt: LoginAttemptDraft = {};
    const result = await subscore('u1', '8.8.8.8', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: false });
    expect(attempt.geoLookupStatus).toBe('unavailable');
  });

  it('default timeoutMs is 2000 ms (Req 9.1)', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(2_000);
  });
});

describe('withTimeout', () => {
  it('resolves with the underlying value before the deadline', async () => {
    const v = await withTimeout(Promise.resolve(42), 50);
    expect(v).toBe(42);
  });

  it('rejects with the timeout sentinel after the deadline', async () => {
    const slow = new Promise<number>((resolve) =>
      setTimeout(() => resolve(1), 50),
    );
    await expect(withTimeout(slow, 5)).rejects.toThrow(
      GEO_TIMEOUT_ERROR_MESSAGE,
    );
  });

  it('passes through non-positive timeouts (no race)', async () => {
    const v = await withTimeout(Promise.resolve('ok'), 0);
    expect(v).toBe('ok');
  });
});

// ── Defensive: baseline loader rejection ───────────────────────────────

describe('geoSubscore — baseline loader rejection', () => {
  it('falls back to warmup when the baseline loader throws', async () => {
    const lookup = makeLookup({ '8.8.8.8': 'US' });
    const subscore = createGeoSubscore(NULL_DB, {
      loadBaseline: async () => {
        throw new Error('db pool exhausted');
      },
      lookup,
    });
    const attempt: LoginAttemptDraft = {};
    // Baseline missing → successfulLogins=0 → warmup.
    const result = await subscore('u1', '8.8.8.8', attempt);
    expect(result).toEqual({ value: 0, baselineWarmup: true });
    expect(attempt.countryCode).toBe('US');
    expect(attempt.geoLookupStatus).toBe('ok');
  });
});
