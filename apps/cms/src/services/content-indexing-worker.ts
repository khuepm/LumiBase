import {
  searchIndexName,
  defaultIndexSettings,
  type QueueProvider,
  type SearchProvider,
} from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/shared/utils';
import { buildSearchDocument } from './search-document';

/**
 * Content indexing worker (search).
 *
 * ItemService enqueues `search:index` / `search:remove` jobs on the
 * `content-indexing` queue on every create/update/soft-delete. Without a
 * consumer those jobs pile up and the search index never reflects content
 * changes — this worker is that consumer for long-lived runtimes (Docker/Node).
 * Cloudflare Workers wire the same handler through their queue consumer export.
 *
 * Tenant isolation: the physical index name is always `{siteId}__{collection}`
 * (see `searchIndexName`), built from the `siteId` carried in the payload.
 */

export const CONTENT_INDEXING_QUEUE = 'content-indexing';

export interface SearchIndexJob {
  siteId: string;
  collection: string;
  id: string;
  data: Record<string, unknown>;
}

export interface SearchRemoveJob {
  siteId: string;
  collection: string;
  id: string;
}

export interface ContentIndexingWorkerDeps {
  search?: SearchProvider;
  queue?: QueueProvider;
}

/**
 * Tracks index names this process has already configured, so settings
 * (stop words, typo tolerance, …) are applied once per index rather than on
 * every document. `configureIndex` is idempotent, so a missed entry only costs
 * a redundant settings call.
 */
function makeConfiguredSet(): Set<string> {
  return new Set<string>();
}

async function ensureConfigured(
  search: SearchProvider,
  indexName: string,
  configured: Set<string>,
): Promise<void> {
  if (configured.has(indexName)) return;
  await search.configureIndex(indexName, defaultIndexSettings());
  configured.add(indexName);
}

/**
 * Process one `search:index` job: configure the tenant index (once) and upsert
 * the enriched document.
 */
export async function processSearchIndexJob(
  search: SearchProvider,
  payload: SearchIndexJob,
  configured: Set<string>,
): Promise<void> {
  const indexName = searchIndexName(payload.siteId, payload.collection);
  await ensureConfigured(search, indexName, configured);
  await search.index(indexName, [
    buildSearchDocument(payload.collection, payload.id, payload.data),
  ]);
}

/**
 * Process one `search:remove` job: drop the document from the tenant index.
 */
export async function processSearchRemoveJob(
  search: SearchProvider,
  payload: SearchRemoveJob,
): Promise<void> {
  const indexName = searchIndexName(payload.siteId, payload.collection);
  await search.delete(indexName, [payload.id]);
}

/**
 * Registers the content-indexing consumer on a long-lived runtime (Docker/Node).
 * No-op when there is no queue or no search provider configured.
 */
export function registerContentIndexingWorker(deps: ContentIndexingWorkerDeps): void {
  const { queue, search } = deps;
  if (!queue || !search) return;

  const configured = makeConfiguredSet();

  queue.process<SearchIndexJob | SearchRemoveJob>(CONTENT_INDEXING_QUEUE, async (job) => {
    try {
      if (job.name === 'search:index') {
        await processSearchIndexJob(search, job.data as SearchIndexJob, configured);
      } else if (job.name === 'search:remove') {
        await processSearchRemoveJob(search, job.data as SearchRemoveJob);
      }
    } catch (err) {
      // Indexing is non-critical to content correctness; log and let the queue
      // apply its own retry policy rather than crashing the worker.
      console.error('[content-indexing] job failed', {
        job: job.name,
        err: formatSafeError(err),
      });
      throw err;
    }
  });
}
