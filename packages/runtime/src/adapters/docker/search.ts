import { MeiliSearch } from 'meilisearch';
import type {
  SearchProvider,
  SearchResult,
  SearchOptions,
  SearchIndexSettings,
} from '../../interfaces';

export class MeiliSearchProvider implements SearchProvider {
  private client: MeiliSearch;

  constructor(host: string, apiKey?: string) {
    this.client = new MeiliSearch({ host, apiKey });
  }

  async index(collection: string, documents: Record<string, unknown>[]): Promise<void> {
    const index = this.client.index(collection);
    await index.addDocuments(documents);
  }

  async search<T>(collection: string, query: string, options?: SearchOptions): Promise<SearchResult<T>> {
    const index = this.client.index(collection);
    const result = await index.search(query, {
      filter: options?.filter,
      sort: options?.sort,
      limit: options?.limit ?? 20,
      offset: options?.offset ?? 0,
      attributesToRetrieve: options?.attributesToRetrieve,
    });
    return {
      hits: result.hits as T[],
      totalHits: result.estimatedTotalHits ?? 0,
      processingTimeMs: result.processingTimeMs,
    };
  }

  async delete(collection: string, documentIds: string[]): Promise<void> {
    const index = this.client.index(collection);
    await index.deleteDocuments(documentIds);
  }

  async getIndex(collection: string): Promise<{ numberOfDocuments: number }> {
    const stats = await this.client.index(collection).getStats();
    return { numberOfDocuments: stats.numberOfDocuments };
  }

  async configureIndex(collection: string, settings: SearchIndexSettings): Promise<void> {
    const index = this.client.index(collection);
    await index.updateSettings(settings);
  }
}
