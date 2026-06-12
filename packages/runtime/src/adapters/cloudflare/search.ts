import type { SearchProvider, SearchResult, SearchOptions } from '../../interfaces';

/**
 * MeiliSearch Cloud-backed SearchProvider for Cloudflare Workers.
 * Uses native fetch API (available in Workers runtime) to call MeiliSearch REST API.
 */
export class CloudflareSearchProvider implements SearchProvider {
  private host: string;
  private apiKey: string;

  constructor(host: string, apiKey: string) {
    // Strip trailing slashes without a regex: `/\/+$/` backtracks
    // polynomially on adversarial input like "http://h/////…". A linear
    // scan from the end is ReDoS-proof.
    let end = host.length;
    while (end > 0 && host.charCodeAt(end - 1) === 47 /* '/' */) end--;
    this.host = host.slice(0, end);
    this.apiKey = apiKey;
  }

  async index(collection: string, documents: Record<string, unknown>[]): Promise<void> {
    const response = await fetch(
      `${this.host}/indexes/${encodeURIComponent(collection)}/documents`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(documents),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MeiliSearch index error (${response.status}): ${error}`);
    }
  }

  async search<T = Record<string, unknown>>(
    collection: string,
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResult<T>> {
    const body: Record<string, unknown> = { q: query };

    if (options?.filter) body.filter = options.filter;
    if (options?.sort) body.sort = options.sort;
    if (options?.limit !== undefined) body.limit = options.limit;
    if (options?.offset !== undefined) body.offset = options.offset;
    if (options?.attributesToRetrieve) body.attributesToRetrieve = options.attributesToRetrieve;

    const response = await fetch(
      `${this.host}/indexes/${encodeURIComponent(collection)}/search`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MeiliSearch search error (${response.status}): ${error}`);
    }

    const result = (await response.json()) as {
      hits: T[];
      estimatedTotalHits?: number;
      processingTimeMs: number;
    };

    return {
      hits: result.hits,
      totalHits: result.estimatedTotalHits ?? 0,
      processingTimeMs: result.processingTimeMs,
    };
  }

  async delete(collection: string, documentIds: string[]): Promise<void> {
    const response = await fetch(
      `${this.host}/indexes/${encodeURIComponent(collection)}/documents/delete-batch`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(documentIds),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MeiliSearch delete error (${response.status}): ${error}`);
    }
  }

  async getIndex(collection: string): Promise<{ numberOfDocuments: number }> {
    const response = await fetch(
      `${this.host}/indexes/${encodeURIComponent(collection)}/stats`,
      {
        method: 'GET',
        headers: this.headers(),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`MeiliSearch getIndex error (${response.status}): ${error}`);
    }

    const stats = (await response.json()) as { numberOfDocuments: number };
    return { numberOfDocuments: stats.numberOfDocuments };
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}
