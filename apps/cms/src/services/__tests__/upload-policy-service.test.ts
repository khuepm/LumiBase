import { describe, expect, it, vi } from 'vitest';
import type { CacheProvider } from '@lumibase/runtime';
import { DEFAULT_UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_MIME_TYPES } from '@lumibase/contracts/schemas';
import {
  envFallbackPolicy,
  resolveUploadPolicy,
  saveUploadPolicy,
} from '../upload-policy-service';

function mockDb(row?: unknown) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
        }),
      }),
    }),
  } as never;
}

type MockCache = CacheProvider & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

function mockCache(getValue?: unknown): MockCache {
  return {
    get: vi.fn(async () => (getValue ?? null) as unknown),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  } as unknown as MockCache;
}

describe('upload policy service', () => {
  it('falls back to env/default when no DB context is present', async () => {
    const config = await resolveUploadPolicy({});
    expect(config.maxBytes).toBe(DEFAULT_UPLOAD_MAX_BYTES);
    expect(config.allowedMimeTypes).toEqual([...DEFAULT_UPLOAD_MIME_TYPES]);
  });

  it('honours env overrides in the fallback path', () => {
    const config = envFallbackPolicy({
      FILE_UPLOAD_MAX_BYTES: '2048',
      FILE_UPLOAD_ALLOWED_MIME_TYPES: 'image/png, application/pdf',
    });
    expect(config).toEqual({ maxBytes: 2048, allowedMimeTypes: ['image/png', 'application/pdf'] });
  });

  it('reads and caches a valid per-site DB config', async () => {
    const cache = mockCache();
    const stored = { maxBytes: 4096, allowedMimeTypes: ['image/png'] };
    const config = await resolveUploadPolicy({
      db: mockDb({ value: stored }),
      cache,
      siteId: 'site_1',
    });
    expect(config).toEqual(stored);
    expect(cache.set).toHaveBeenCalledWith('upload-policy:site_1', JSON.stringify(stored), { ttl: 300 });
  });

  it('ignores a malformed DB config and returns the fallback', async () => {
    const config = await resolveUploadPolicy({
      db: mockDb({ value: { maxBytes: -1, allowedMimeTypes: [] } }),
      siteId: 'site_1',
    });
    expect(config.maxBytes).toBe(DEFAULT_UPLOAD_MAX_BYTES);
  });

  it('returns the cached config without hitting the DB', async () => {
    const cache = mockCache({ maxBytes: 1234, allowedMimeTypes: ['text/plain'] });
    const db = { select: vi.fn() } as never;
    const config = await resolveUploadPolicy({ db, cache, siteId: 'site_1' });
    expect(config).toEqual({ maxBytes: 1234, allowedMimeTypes: ['text/plain'] });
    expect((db as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
  });

  it('never throws — a DB failure degrades to the fallback', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              throw new Error('db down');
            },
          }),
        }),
      }),
    } as never;
    const config = await resolveUploadPolicy({ db, siteId: 'site_1' });
    expect(config.maxBytes).toBe(DEFAULT_UPLOAD_MAX_BYTES);
  });

  it('persists a config and invalidates the cache', async () => {
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn(async () => undefined) });
    const db = { insert: vi.fn().mockReturnValue({ values }) } as never;
    const cache = mockCache();

    const saved = await saveUploadPolicy(
      { db, cache, siteId: 'site_1' },
      { maxBytes: 8192, allowedMimeTypes: ['image/png', 'image/jpeg'] },
    );

    expect(saved).toEqual({ maxBytes: 8192, allowedMimeTypes: ['image/png', 'image/jpeg'] });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'upload_policy', siteId: 'site_1', value: saved }),
    );
    expect(cache.delete).toHaveBeenCalledWith('upload-policy:site_1');
  });
});
