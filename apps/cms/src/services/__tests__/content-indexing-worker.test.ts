import { searchIndexName, type SearchProvider } from '@lumibase/runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  processSearchIndexJob,
  processSearchRemoveJob,
  searchSnapshotHash,
  type CurrentItemReader,
} from '../content-indexing-worker';

type MockedSearch = {
  [K in keyof SearchProvider]: ReturnType<typeof vi.fn>;
};

function makeSearch(): MockedSearch {
  return {
    index: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    getIndex: vi.fn(),
    configureIndex: vi.fn().mockResolvedValue(undefined),
    search: vi.fn(),
  };
}

describe('content-indexing worker', () => {
  it('indexes into the site-scoped index and configures it once', async () => {
    const search = makeSearch();
    const configured = new Set<string>();
    const payload = { siteId: 'site_A', collection: 'articles', id: 'i1', data: { title: 'Hà Nội' } };

    await processSearchIndexJob(search as unknown as SearchProvider, payload, configured);
    await processSearchIndexJob(search as unknown as SearchProvider, { ...payload, id: 'i2' }, configured);

    const expectedIndex = searchIndexName('site_A', 'articles');
    expect(search.index).toHaveBeenCalledTimes(2);
    expect(search.index.mock.calls[0]?.[0]).toBe(expectedIndex);
    // configureIndex is applied once per index, not per document.
    expect(search.configureIndex).toHaveBeenCalledTimes(1);
    expect(search.configureIndex.mock.calls[0]?.[0]).toBe(expectedIndex);
  });

  it('removes from the site-scoped index', async () => {
    const search = makeSearch();
    await processSearchRemoveJob(search as unknown as SearchProvider, { siteId: 'site_B', collection: 'pages', id: 'i9' });
    expect(search.delete).toHaveBeenCalledWith(searchIndexName('site_B', 'pages'), ['i9']);
  });

  describe('stale snapshots (#857)', () => {
    const payload = (data: Record<string, unknown>, dataHash?: string) => ({ siteId: 'site_A', collection: 'articles', id: 'i1', data, ...(dataHash ? { dataHash } : {}) });
    const reader = (row: { data: unknown; deletedAt: Date | null } | null): CurrentItemReader => vi.fn(async () => row);

    it('removes instead of indexing when the item is soft-deleted', async () => {
      const search = makeSearch();
      const read = reader({ data: { title: 'a' }, deletedAt: new Date() });
      await processSearchIndexJob(search as unknown as SearchProvider, payload({ title: 'a' }, await searchSnapshotHash({ title: 'a' })), new Set(), read);
      expect(read).toHaveBeenCalledWith({ siteId: 'site_A', collection: 'articles', id: 'i1' });
      expect(search.index).not.toHaveBeenCalled();
      expect(search.delete).toHaveBeenCalledWith(searchIndexName('site_A', 'articles'), ['i1']);
    });

    it('removes instead of indexing when the item no longer exists', async () => {
      const search = makeSearch();
      await processSearchIndexJob(search as unknown as SearchProvider, payload({ title: 'a' }), new Set(), reader(null));
      expect(search.index).not.toHaveBeenCalled();
      expect(search.delete).toHaveBeenCalledOnce();
    });

    it('skips a snapshot older than the stored item', async () => {
      const search = makeSearch();
      const v1 = { title: 'v1' };
      await processSearchIndexJob(search as unknown as SearchProvider, payload(v1, await searchSnapshotHash(v1)), new Set(), reader({ data: { title: 'v2' }, deletedAt: null }));
      expect(search.index).not.toHaveBeenCalled();
      expect(search.delete).not.toHaveBeenCalled();
    });

    it('indexes a snapshot of the stored item, and a legacy job without a hash for a live item', async () => {
      const search = makeSearch();
      const stored = { title: 'v2', body: { b: 1, a: [1, 2] } };
      // Key order does not matter: jsonb does not preserve it.
      const reordered = { body: { a: [1, 2], b: 1 }, title: 'v2' };
      await processSearchIndexJob(search as unknown as SearchProvider, payload(stored, await searchSnapshotHash(reordered)), new Set(), reader({ data: stored, deletedAt: null }));
      await processSearchIndexJob(search as unknown as SearchProvider, payload({ title: 'legacy' }), new Set(), reader({ data: stored, deletedAt: null }));
      expect(search.index).toHaveBeenCalledTimes(2);
    });
  });
});
