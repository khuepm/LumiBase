import { describe, expect, it, vi } from 'vitest';
import type { CacheProvider } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import { bumpSchemaVersion, readSchemaVersion } from '../schema-version';
import { SchemaService } from '../schema-service';

function cacheWith(increment = true) {
  const store = new Map<string, string>();
  const cache = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
    ...(increment
      ? {
          increment: vi.fn(async (key: string) => {
            const next = Number(store.get(key) ?? 0) + 1;
            store.set(key, String(next));
            return next;
          }),
        }
      : {}),
  };
  return cache as unknown as CacheProvider;
}

describe('schema version pointer (#745)', () => {
  it('starts at 0 and increases on every bump, per site', async () => {
    const cache = cacheWith();
    expect(await readSchemaVersion(cache, 'a')).toBe(0);
    await bumpSchemaVersion(cache, 'a');
    await bumpSchemaVersion(cache, 'a');
    expect(await readSchemaVersion(cache, 'a')).toBe(2);
    expect(await readSchemaVersion(cache, 'b')).toBe(0);
  });

  it('falls back to get/set without an atomic increment', async () => {
    const cache = cacheWith(false);
    await bumpSchemaVersion(cache, 'a');
    expect(await readSchemaVersion(cache, 'a')).toBe(1);
  });

  it('never throws when the cache is down', async () => {
    const cache = { get: vi.fn().mockRejectedValue(new Error('down')), increment: vi.fn().mockRejectedValue(new Error('down')) };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(bumpSchemaVersion(cache as unknown as CacheProvider, 'a')).resolves.toBeUndefined();
    await expect(readSchemaVersion(cache as unknown as CacheProvider, 'a')).resolves.toBe(0);
    warn.mockRestore();
  });

  it('is bumped by SchemaService.invalidate, which every schema mutation calls', async () => {
    const cache = cacheWith();
    const service = new SchemaService({ db: {} as Database, siteId: 'site-a', cache });
    await service.invalidate('posts');
    expect(await readSchemaVersion(cache, 'site-a')).toBe(1);
  });
});
