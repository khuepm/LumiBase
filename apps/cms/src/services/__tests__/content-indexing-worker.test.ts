import { searchIndexName, type SearchProvider } from '@lumibase/runtime';
import { describe, expect, it, vi } from 'vitest';
import {
  processSearchIndexJob,
  processSearchRemoveJob,
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
});
