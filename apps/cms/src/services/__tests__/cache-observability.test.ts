import { describe, expect, it, beforeEach } from 'vitest';
import type { CacheEvent } from '@lumibase/runtime';
import {
  getCacheOperationalStatus,
  getCacheErrorRate,
  recordCacheOperationEvent,
  resetCacheObservabilityForTests,
} from '../cache-observability';

describe('cache observability', () => {
  beforeEach(() => {
    resetCacheObservabilityForTests();
  });

  it('reports ok when no errors in the 60s window', () => {
    recordCacheOperationEvent({ op: 'get', result: 'hit', backend: 'redis' });
    expect(getCacheOperationalStatus()).toBe('ok');
    expect(getCacheErrorRate()).toBe(0);
  });

  it('reports degraded when error rate exceeds 50% over 60s', () => {
    const base = Date.now();
    recordCacheOperationEvent({ op: 'get', result: 'error', backend: 'redis' });
    recordCacheOperationEvent({ op: 'get', result: 'unavailable', backend: 'redis' });
    recordCacheOperationEvent({ op: 'set', result: 'ok', backend: 'redis' });
    expect(getCacheOperationalStatus(base + 1000)).toBe('degraded');
    expect(getCacheErrorRate(base + 1000)).toBeCloseTo(2 / 3);
  });
});
