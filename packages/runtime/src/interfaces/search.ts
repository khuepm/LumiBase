export interface SearchResult<T = Record<string, unknown>> {
  hits: T[];
  totalHits: number;
  processingTimeMs: number;
}

export interface SearchOptions {
  filter?: string;
  sort?: string[];
  limit?: number;
  offset?: number;
  attributesToRetrieve?: string[];
}

/**
 * Index-level settings applied to a search index. Mirrors the subset of
 * MeiliSearch settings LumiBase configures; providers map these onto their
 * backend's native settings API.
 */
export interface SearchIndexSettings {
  searchableAttributes?: string[];
  filterableAttributes?: string[];
  sortableAttributes?: string[];
  displayedAttributes?: string[];
  stopWords?: string[];
  typoTolerance?: {
    enabled?: boolean;
    minWordSizeForTypos?: { oneTypo?: number; twoTypos?: number };
  };
}

export interface SearchProvider {
  index(collection: string, documents: Record<string, unknown>[]): Promise<void>;
  search<T = Record<string, unknown>>(collection: string, query: string, options?: SearchOptions): Promise<SearchResult<T>>;
  delete(collection: string, documentIds: string[]): Promise<void>;
  getIndex(collection: string): Promise<{ numberOfDocuments: number }>;
  /**
   * Apply index-level settings (searchable attributes, stop words, typo
   * tolerance, …). Idempotent — safe to call on every index bootstrap.
   */
  configureIndex(collection: string, settings: SearchIndexSettings): Promise<void>;
}

/**
 * Build the physical search-index name for a tenant + collection.
 *
 * Search indexes are shared infrastructure (a single MeiliSearch instance
 * serves every site), so the tenant boundary MUST live in the index name.
 * Every index/search/delete call goes through this helper so a tenant can
 * never read or write another tenant's index.
 */
export function searchIndexName(siteId: string, collection: string): string {
  return `${siteId}__${collection}`;
}
