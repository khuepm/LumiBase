import {
  searchIndexName,
  defaultIndexSettings,
  type QueueProvider,
  type SearchProvider,
} from '@lumibase/runtime';
import { collections, items, scopeSite, type Database } from '@lumibase/database';
import { formatSafeError } from '@lumibase/contracts/utils';
import { and, eq } from 'drizzle-orm';
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
 *
 * Ordering (#857): jobs are applied as they arrive and a failed job is retried
 * later, after newer jobs for the same item may already have run. So before a
 * `search:index` snapshot is written, the worker re-reads the item row: a
 * deleted or missing item is removed from the index instead (delete wins), and
 * a snapshot whose `dataHash` no longer matches the stored data is skipped —
 * the write that changed the data enqueued its own, newer job. A legacy job
 * without `dataHash` is applied only when its data equals the stored data.
 */

export const CONTENT_INDEXING_QUEUE = 'content-indexing';

export interface SearchIndexJob {
  siteId: string;
  collection: string;
  id: string;
  data: Record<string, unknown>;
  /**
   * `searchSnapshotHash` of the item's stored `data` (as persisted, i.e. with
   * encrypted fields still encrypted) at the write that produced `data`.
   * Optional so jobs enqueued before #857 still drain.
   */
  dataHash?: string;
}

export interface SearchRemoveJob {
  siteId: string;
  collection: string;
  id: string;
}

export interface ContentIndexingWorkerDeps {
  /** System-scope connection: a queue carries jobs of several sites. */
  db?: Database;
  search?: SearchProvider;
  queue?: QueueProvider;
}

/** The item's current stored state, or `null` when the row no longer exists. */
export interface CurrentItemState {
  data: unknown;
  deletedAt: Date | null;
}

export type CurrentItemReader = (ref: SearchRemoveJob) => Promise<CurrentItemState | null>;

/** Canonical JSON: object keys sorted, so jsonb key order never changes the hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Fingerprint of an item's stored `data`. Producer and consumer both hash the
 * persisted form, so the worker can tell whether a snapshot still describes the
 * row without decrypting anything.
 */
export async function searchSnapshotHash(storedData: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(storedData)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Reads the item row by `(siteId, collection name, id)`, site-scoped on both tables. */
export function dbCurrentItemReader(db: Database): CurrentItemReader {
  return async ({ siteId, collection, id }) => {
    const [row] = await db
      .select({ data: items.data, deletedAt: items.deletedAt })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(
        and(
          scopeSite(items.siteId, siteId),
          scopeSite(collections.siteId, siteId),
          eq(collections.name, collection),
          eq(items.id, id),
        ),
      )
      .limit(1);
    return row ?? null;
  };
}

export interface ContentIndexingWorkerOptions {
  /**
   * Index names already configured. Pass a long-lived set when this function
   * runs more than once per process: the Workers consumer registers per batch,
   * and a fresh set each time re-applied the settings on every batch (#863).
   * Defaults to a new set, which is right for a register-once runtime.
   */
  configured?: Set<string>;
}

/**
 * Tracks index names this process has already configured, so settings
 * (stop words, typo tolerance, …) are applied once per index rather than on
 * every document. `configureIndex` is idempotent, so a missed entry only costs
 * a redundant settings call.
 */
export function makeConfiguredSet(): Set<string> {
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
 * the enriched document. With `readCurrent`, a snapshot of a deleted item
 * removes it instead, and a stale snapshot is skipped (#857).
 */
export async function processSearchIndexJob(
  search: SearchProvider,
  payload: SearchIndexJob,
  configured: Set<string>,
  readCurrent?: CurrentItemReader,
): Promise<void> {
  if (readCurrent) {
    const current = await readCurrent({ siteId: payload.siteId, collection: payload.collection, id: payload.id });
    if (!current || current.deletedAt) {
      await processSearchRemoveJob(search, payload);
      return;
    }
    if (payload.dataHash !== undefined) {
      if (payload.dataHash !== (await searchSnapshotHash(current.data))) return;
    } else if (canonicalJson(payload.data) !== canonicalJson(current.data)) {
      // Legacy job (enqueued before #857, no hash). Its snapshot is provably
      // current only when it equals the stored data; otherwise the item changed
      // since (or has encrypted fields, which this worker cannot decrypt) and
      // the old snapshot could overwrite a newer entry. Drop it; the next edit or
      // `lumibase reindex` brings the entry up to date. Never log the data.
      console.warn('[content-indexing] dropped legacy search:index job that no longer matches the item', {
        siteId: payload.siteId,
        collection: payload.collection,
        id: payload.id,
      });
      return;
    }
  }
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
export function registerContentIndexingWorker(
  deps: ContentIndexingWorkerDeps,
  options: ContentIndexingWorkerOptions = {},
): void {
  const { queue, search, db } = deps;
  if (!queue || !search) return;

  const configured = options.configured ?? makeConfiguredSet();
  const readCurrent = db ? dbCurrentItemReader(db) : undefined;

  queue.process<SearchIndexJob | SearchRemoveJob>(CONTENT_INDEXING_QUEUE, async (job) => {
    try {
      if (job.name === 'search:index') {
        await processSearchIndexJob(search, job.data as SearchIndexJob, configured, readCurrent);
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
