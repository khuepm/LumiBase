import { describe, expect, it } from 'vitest';
import {
  etagMatches,
  resolveDeliveryCachePolicy,
  weakEtag,
} from '../delivery-cache';

/**
 * Unit tests for the Delivery HTTP-cache helpers
 * (high-load-cache-readiness Req 1; design §13.4 Properties P1, P3).
 */

describe('resolveDeliveryCachePolicy', () => {
  it('emits public s-maxage + stale-while-revalidate defaults when no credentials', () => {
    const policy = resolveDeliveryCachePolicy({ hasCredentials: false, env: {} });
    expect(policy.cacheable).toBe(true);
    expect(policy.cacheControl).toBe('public, s-maxage=60, stale-while-revalidate=300');
  });

  it('honours env knobs', () => {
    const policy = resolveDeliveryCachePolicy({
      hasCredentials: false,
      env: { LUMIBASE_DELIVER_SMAXAGE: '120', LUMIBASE_DELIVER_SWR: '600' },
    });
    expect(policy.cacheControl).toBe('public, s-maxage=120, stale-while-revalidate=600');
  });

  it('disables public caching when s-maxage is 0', () => {
    const policy = resolveDeliveryCachePolicy({
      hasCredentials: false,
      env: { LUMIBASE_DELIVER_SMAXAGE: '0' },
    });
    expect(policy.cacheable).toBe(false);
    expect(policy.cacheControl).toBe('private, no-store');
  });

  it('never allows shared caching for credentialed requests (Req 1.4)', () => {
    const policy = resolveDeliveryCachePolicy({ hasCredentials: true, env: {} });
    expect(policy.cacheable).toBe(false);
    expect(policy.cacheControl).toBe('private, no-store');
  });

  it('falls back to defaults on malformed env values', () => {
    const policy = resolveDeliveryCachePolicy({
      hasCredentials: false,
      env: { LUMIBASE_DELIVER_SMAXAGE: 'abc', LUMIBASE_DELIVER_SWR: '-5' },
    });
    expect(policy.cacheControl).toBe('public, s-maxage=60, stale-while-revalidate=300');
  });
});

describe('weakEtag', () => {
  it('is deterministic for identical inputs (Property P1)', async () => {
    const a = await weakEtag(['site', 'slug', false, new Date('2026-01-01'), 'x', 3]);
    const b = await weakEtag(['site', 'slug', false, new Date('2026-01-01'), 'x', 3]);
    expect(a).toBe(b);
    expect(a).toMatch(/^W\/"[0-9a-f]{32}"$/);
  });

  it('changes when any fingerprint input changes (Property P1)', async () => {
    const base = await weakEtag(['site', 'slug', false, 'ts', 5]);
    expect(await weakEtag(['site', 'slug', true, 'ts', 5])).not.toBe(base);
    expect(await weakEtag(['site', 'slug', false, 'ts2', 5])).not.toBe(base);
    expect(await weakEtag(['site', 'slug', false, 'ts', 6])).not.toBe(base);
    expect(await weakEtag(['site', 'other', false, 'ts', 5])).not.toBe(base);
  });

  it('treats null and undefined as empty segments', async () => {
    expect(await weakEtag([null, 'x'])).toBe(await weakEtag([undefined, 'x']));
  });
});

describe('etagMatches', () => {
  const etag = 'W/"abc123"';

  it('matches the exact weak tag', () => {
    expect(etagMatches('W/"abc123"', etag)).toBe(true);
  });

  it('uses weak comparison — strong candidate matches weak tag', () => {
    expect(etagMatches('"abc123"', etag)).toBe(true);
  });

  it('matches within a comma-separated list', () => {
    expect(etagMatches('"zzz", W/"abc123", "yyy"', etag)).toBe(true);
  });

  it('matches the * wildcard', () => {
    expect(etagMatches('*', etag)).toBe(true);
  });

  it('rejects non-matching and missing headers', () => {
    expect(etagMatches('W/"other"', etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches(null, etag)).toBe(false);
    expect(etagMatches('', etag)).toBe(false);
  });
});
