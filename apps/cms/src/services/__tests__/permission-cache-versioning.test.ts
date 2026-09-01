import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import type { CacheProvider } from '@lumibase/runtime';
import {
  PermissionService,
  __resetPermissionProcessCacheForTests,
  type PermissionBundle,
} from '../permission-service';
import type { MagicContext } from '../permission-dsl';

/**
 * Tests for permission-cache key versioning
 * (high-load-cache-readiness Req 2; design §5.1, §13.4 Properties P4/P9).
 *
 * A fake cache mirrors the real adapters' contract: values are stored as the
 * string handed to `set()` and JSON-parsed on `get()` (both the KV and Redis
 * adapters read with JSON semantics). `compile()` is stubbed so no Postgres
 * is needed — the subject under test is the cache-key protocol, not the
 * bundle compiler.
 */

class FakeCache implements CacheProvider {
  store = new Map<string, string>();
  async get<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async increment(key: string, by = 1): Promise<number> {
    const next = Number(this.store.get(key) ?? '0') + by;
    this.store.set(key, String(next));
    return next;
  }
  async getEntry<T>(key: string) {
    const raw = this.store.get(key);
    if (raw === undefined) return { state: 'miss' as const };
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && (parsed as { __lumi?: string }).__lumi === 'neg') {
      return { state: 'negative' as const };
    }
    return { state: 'hit' as const, value: parsed as T };
  }
  async setNegative(key: string, options?: { ttl?: number }) {
    void options;
    this.store.set(key, JSON.stringify({ __lumi: 'neg', v: 1 }));
  }
  async invalidateByTag(): Promise<void> {
    // not used in permission-cache tests
  }
}

const BUNDLE: PermissionBundle = {
  admin: false,
  appAccess: false,
  tfaRequired: false,
  byKey: {},
  roles: [],
  policies: [],
};

function anonCtx(siteId: string): MagicContext {
  return {
    userId: null,
    siteId,
    roleId: null,
    user: null,
    ip: null,
    headers: {},
    apiKey: null,
  } as unknown as MagicContext;
}

function serviceFor(siteId: string, cache: CacheProvider) {
  const service = new PermissionService({
    db: {} as Database,
    cache,
    ctx: anonCtx(siteId),
  });
  const compileSpy = vi
    .spyOn(service as unknown as { compile(): Promise<PermissionBundle> }, 'compile')
    .mockResolvedValue(BUNDLE);
  return { service, compileSpy };
}

describe('PermissionService cache versioning', () => {
  // The process-cache store (#391) is module-level by design, so it outlives a
  // single case. Without this reset a later case could be answered from an
  // earlier one's entry and pass for the wrong reason.
  beforeEach(() => {
    __resetPermissionProcessCacheForTests();
  });

  it('stores bundles under a versioned, tenant-prefixed key (Property P4)', async () => {
    const cache = new FakeCache();
    const { service } = serviceFor('site-a', cache);

    await service.bundle();

    expect(cache.store.has('perm:site-a:v1:anon')).toBe(true);
  });

  it('serves subsequent principals from cache without recompiling', async () => {
    const cache = new FakeCache();
    await serviceFor('site-a', cache).service.bundle();

    const { service, compileSpy } = serviceFor('site-a', cache);
    const bundle = await service.bundle();

    expect(bundle).toEqual(BUNDLE);
    expect(compileSpy).not.toHaveBeenCalled();
  });

  it('bumpVersion orphans every cached bundle for the site (Req 2.2; Property P9)', async () => {
    const cache = new FakeCache();
    await serviceFor('site-a', cache).service.bundle();

    await PermissionService.bumpVersion(cache, 'site-a');
    expect(cache.store.get('perm-ver:site-a')).toBe('2');

    const { service, compileSpy } = serviceFor('site-a', cache);
    await service.bundle();

    // Miss under v2 → recompiled and stored under the new versioned key.
    expect(compileSpy).toHaveBeenCalledTimes(1);
    expect(cache.store.has('perm:site-a:v2:anon')).toBe(true);
  });

  it('bumping one site does not invalidate another (DoD 2b two-site check)', async () => {
    const cache = new FakeCache();
    await serviceFor('site-a', cache).service.bundle();
    await serviceFor('site-b', cache).service.bundle();

    await PermissionService.bumpVersion(cache, 'site-a');

    const { service, compileSpy } = serviceFor('site-b', cache);
    await service.bundle();
    expect(compileSpy).not.toHaveBeenCalled();
  });

  it('repeated bumps keep incrementing the version pointer', async () => {
    const cache = new FakeCache();
    await PermissionService.bumpVersion(cache, 'site-a');
    await PermissionService.bumpVersion(cache, 'site-a');
    await PermissionService.bumpVersion(cache, 'site-a');
    expect(cache.store.get('perm-ver:site-a')).toBe('4');
  });

  it('tolerates a missing cache (no-op) and cache errors (TTL safety net)', async () => {
    await expect(PermissionService.bumpVersion(undefined, 'site-a')).resolves.toBeUndefined();
    await expect(PermissionService.bumpVersion(null, 'site-a')).resolves.toBeUndefined();

    // Real adapters swallow backend errors and degrade to null/no-op
    // (docker/cache.ts); bumpVersion must never throw even if one leaks.
    const broken = {
      get: vi.fn().mockRejectedValue(new Error('redis down')),
      set: vi.fn().mockRejectedValue(new Error('redis down')),
      delete: vi.fn(),
      getEntry: vi.fn().mockResolvedValue({ state: 'unavailable' }),
      setNegative: vi.fn().mockRejectedValue(new Error('redis down')),
      increment: vi.fn(),
    } as unknown as CacheProvider;
    await expect(PermissionService.bumpVersion(broken, 'site-a')).resolves.toBeUndefined();
  });

  /**
   * #391 — the in-process layer must not buy latency at the cost of the
   * guarantee Req 2 exists for. Bundles are cached under a versioned key; the
   * version pointer itself is read from the shared cache every time, so a bump
   * is visible on the very next request rather than after a process TTL.
   */
  it('does not delay revocation: a bump is seen on the next request (Property P9)', async () => {
    const cache = new FakeCache();
    await serviceFor('site-a', cache).service.bundle();

    // Same process, entry still well inside its 5s process TTL.
    await PermissionService.bumpVersion(cache, 'site-a');

    const { service, compileSpy } = serviceFor('site-a', cache);
    await service.bundle();

    expect(compileSpy).toHaveBeenCalledTimes(1);
    expect(cache.store.has('perm:site-a:v2:anon')).toBe(true);
  });

  it('answers a repeat read from the process store without a second bundle fetch', async () => {
    const cache = new FakeCache();
    await serviceFor('site-a', cache).service.bundle();

    const reads: string[] = [];
    const original = cache.get.bind(cache);
    cache.get = (async (key: string) => {
      reads.push(key);
      return original(key);
    }) as typeof cache.get;

    const { service, compileSpy } = serviceFor('site-a', cache);
    await service.bundle();

    expect(compileSpy).not.toHaveBeenCalled();
    // The version pointer is still read — that is what keeps revocation
    // immediate — but the bundle itself came from process memory.
    expect(reads).toEqual(['perm-ver:site-a']);
  });
});
