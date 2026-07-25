import { describe, expect, it, vi } from 'vitest';
import type { CacheProvider } from '@lumibase/runtime';
import {
  DEFAULT_REGISTRATION_RATE_LIMIT,
  checkRegistrationRate,
  checkIpRateLimit,
} from '../registration-guard';

function memoryCache(initial: Record<string, string> = {}): CacheProvider {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    // `get` is generic (`<T = string>`); return `any` so the async mock is
    // assignable to the CacheProvider signature.
    get: vi.fn(async (k: string): Promise<any> => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string): Promise<void> => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string): Promise<void> => {
      store.delete(k);
    }),
    increment: vi.fn(async (k: string, by = 1): Promise<number> => {
      const next = Number(store.get(k) ?? '0') + by;
      store.set(k, String(next));
      return next;
    }),
  };
}

describe('checkRegistrationRate', () => {
  it('allows and increments under the limit', async () => {
    const cache = memoryCache();
    const v1 = await checkRegistrationRate(cache, 'site-1', '1.2.3.4');
    expect(v1.allowed).toBe(true);
    expect(cache.set).toHaveBeenCalledWith(
      'reg-rate:site-1:1.2.3.4',
      '1',
      { ttl: DEFAULT_REGISTRATION_RATE_LIMIT.windowSeconds },
    );
  });

  it('blocks once the window count reaches the max', async () => {
    const cache = memoryCache({
      'reg-rate:site-1:1.2.3.4': String(DEFAULT_REGISTRATION_RATE_LIMIT.maxPerWindow),
    });
    const verdict = await checkRegistrationRate(cache, 'site-1', '1.2.3.4');
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBe(DEFAULT_REGISTRATION_RATE_LIMIT.windowSeconds);
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('scopes the counter per site + IP', async () => {
    const cache = memoryCache({ 'reg-rate:site-1:1.2.3.4': '99' });
    // Same IP, different site → independent counter, allowed.
    const verdict = await checkRegistrationRate(cache, 'site-2', '1.2.3.4');
    expect(verdict.allowed).toBe(true);
  });

  it('allows when the IP is unknown (cannot key it)', async () => {
    const cache = memoryCache();
    const verdict = await checkRegistrationRate(cache, 'site-1', undefined);
    expect(verdict.allowed).toBe(true);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('fails open when the cache throws', async () => {
    const cache: CacheProvider = {
      get: vi.fn(async (): Promise<any> => {
        throw new Error('cache down');
      }),
      set: vi.fn(async (): Promise<void> => undefined),
      delete: vi.fn(async (): Promise<void> => undefined),
      increment: vi.fn(async (): Promise<number> => {
        throw new Error('cache down');
      }),
    };
    const verdict = await checkRegistrationRate(cache, 'site-1', '1.2.3.4');
    expect(verdict.allowed).toBe(true);
  });

  it('namespaces counters by scope (registration vs forgot-password)', async () => {
    const cache = memoryCache();
    await checkIpRateLimit(cache, 'forgot-rate', 'site-1', '1.2.3.4', {
      maxPerWindow: 3,
      windowSeconds: 60,
    });
    expect(cache.set).toHaveBeenCalledWith('forgot-rate:site-1:1.2.3.4', '1', { ttl: 60 });
    // A different scope for the same site+IP is an independent bucket.
    await checkRegistrationRate(cache, 'site-1', '1.2.3.4');
    expect(cache.set).toHaveBeenCalledWith(
      'reg-rate:site-1:1.2.3.4',
      '1',
      { ttl: DEFAULT_REGISTRATION_RATE_LIMIT.windowSeconds },
    );
  });

  it('honours a custom limit', async () => {
    const cache = memoryCache({ 'reg-rate:site-1:9.9.9.9': '2' });
    const verdict = await checkRegistrationRate(cache, 'site-1', '9.9.9.9', {
      maxPerWindow: 2,
      windowSeconds: 60,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBe(60);
  });
});
