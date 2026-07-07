import { describe, expect, it } from 'vitest';
import { apiKeyTouchIntervalMs, shouldTouchApiKey } from '../auth';

/**
 * Unit tests for the API-key lastUsedAt debounce
 * (high-load-cache-readiness Req 3; design §6.2, Property P14).
 */

describe('apiKeyTouchIntervalMs', () => {
  it('defaults to 60s when unset', () => {
    expect(apiKeyTouchIntervalMs(undefined)).toBe(60_000);
    expect(apiKeyTouchIntervalMs({})).toBe(60_000);
  });

  it('reads the configured interval (seconds → ms)', () => {
    expect(apiKeyTouchIntervalMs({ LUMIBASE_APIKEY_TOUCH_INTERVAL: '30' })).toBe(30_000);
    expect(apiKeyTouchIntervalMs({ LUMIBASE_APIKEY_TOUCH_INTERVAL: '0' })).toBe(0);
  });

  it('falls back to the default on garbage input', () => {
    expect(apiKeyTouchIntervalMs({ LUMIBASE_APIKEY_TOUCH_INTERVAL: 'abc' })).toBe(60_000);
    expect(apiKeyTouchIntervalMs({ LUMIBASE_APIKEY_TOUCH_INTERVAL: '-5' })).toBe(60_000);
  });
});

describe('shouldTouchApiKey', () => {
  const now = new Date('2026-07-05T12:00:00.000Z');

  it('touches when never used before', () => {
    expect(shouldTouchApiKey(null, now, 60_000)).toBe(true);
    expect(shouldTouchApiKey(undefined, now, 60_000)).toBe(true);
  });

  it('skips when the last touch is within the interval (Property P14)', () => {
    const recent = new Date(now.getTime() - 10_000); // 10s ago, interval 60s
    expect(shouldTouchApiKey(recent, now, 60_000)).toBe(false);
  });

  it('touches when the last touch is older than the interval', () => {
    const stale = new Date(now.getTime() - 61_000); // 61s ago, interval 60s
    expect(shouldTouchApiKey(stale, now, 60_000)).toBe(true);
  });

  it('touches exactly at the interval boundary', () => {
    const boundary = new Date(now.getTime() - 60_000);
    expect(shouldTouchApiKey(boundary, now, 60_000)).toBe(true);
  });

  it('always touches when the interval is 0 (debounce disabled)', () => {
    const justNow = new Date(now.getTime() - 1);
    expect(shouldTouchApiKey(justNow, now, 0)).toBe(true);
  });

  it('models the 100-requests-in-a-minute case: only the first touches', () => {
    // First request: no prior timestamp → touch, stamping `now`.
    expect(shouldTouchApiKey(null, now, 60_000)).toBe(true);
    // The next 99 requests within the window all see that stamp → skip.
    for (let i = 1; i < 100; i += 1) {
      const t = new Date(now.getTime() + i * 500); // 0.5s apart → within 60s
      expect(shouldTouchApiKey(now, t, 60_000)).toBe(false);
    }
  });
});
