/**
 * Content cache invalidation + ISR revalidation dispatch
 * (high-load-cache-readiness Req 8; design §3.3).
 */

import { settings, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import type { CacheProvider, QueueProvider } from '@lumibase/runtime';
import { dispatchRevalidation, parseTargets } from './revalidation';

export const REVALIDATION_DISPATCH_QUEUE = 'revalidation-dispatch';

export interface RevalidationDispatchJob {
  siteId: string;
  collection: string;
}

export function itemsTag(siteId: string, collection: string): string {
  return `items:${siteId}:${collection}`;
}

export function deliverTag(siteId: string): string {
  return `deliver:${siteId}`;
}

/** Best-effort tag purge for item collection writes — never fails the caller. */
export async function invalidateItemsTag(
  cache: CacheProvider | null | undefined,
  siteId: string,
  collection: string,
): Promise<void> {
  if (!cache || !siteId) return;
  try {
    await cache.invalidateByTag(itemsTag(siteId, collection));
  } catch (error) {
    console.warn('[content-invalidation] items tag purge failed', {
      siteId,
      collection,
      error,
    });
    void import('../routes/metrics').then((m) =>
      m.cacheOperationsTotal.inc({ op: 'invalidateByTag', result: 'error', backend: 'unknown' }),
    );
  }
}

/** Best-effort deliver-site tag purge (schema apply). */
export async function invalidateDeliverTag(
  cache: CacheProvider | null | undefined,
  siteId: string,
): Promise<void> {
  if (!cache || !siteId) return;
  try {
    await cache.invalidateByTag(deliverTag(siteId));
  } catch (error) {
    console.warn('[content-invalidation] deliver tag purge failed', { siteId, error });
    void import('../routes/metrics').then((m) =>
      m.cacheOperationsTotal.inc({ op: 'invalidateByTag', result: 'error', backend: 'unknown' }),
    );
  }
}

/** Load targets and dispatch ISR revalidation for one collection tag. */
export async function runRevalidationDispatch(
  db: Database,
  siteId: string,
  collection: string,
): Promise<void> {
  const [row] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.siteId, siteId), eq(settings.key, 'revalidation.targets')));
  const targets = parseTargets(row?.value);
  if (targets.length === 0) return;

  const results = await dispatchRevalidation(targets, [collection]);
  void import('../routes/metrics').then((m) => {
    for (const result of results) {
      m.revalidationDispatchesTotal.inc({ ok: result.ok ? 'true' : 'false' });
    }
  });
}

/**
 * Enqueue or fire-and-forget ISR revalidation after an item mutation.
 * Best-effort — never fails the write path.
 */
export async function dispatchItemRevalidation(deps: {
  db: Database;
  queue?: QueueProvider;
  siteId: string;
  collection: string;
}): Promise<void> {
  try {
    if (deps.queue) {
      await deps.queue.enqueue<RevalidationDispatchJob>(REVALIDATION_DISPATCH_QUEUE, 'dispatch', {
        siteId: deps.siteId,
        collection: deps.collection,
      });
      return;
    }
    void runRevalidationDispatch(deps.db, deps.siteId, deps.collection).catch((error) => {
      console.warn('[content-invalidation] revalidation dispatch failed', {
        siteId: deps.siteId,
        collection: deps.collection,
        error,
      });
    });
  } catch (error) {
    console.warn('[content-invalidation] revalidation enqueue failed', {
      siteId: deps.siteId,
      collection: deps.collection,
      error,
    });
  }
}

export interface RevalidationWorkerDeps {
  db: Database;
  queue?: QueueProvider;
}

/** Long-lived consumer for `revalidation-dispatch` jobs (Docker/Node). */
export function registerRevalidationWorker(deps: RevalidationWorkerDeps): void {
  deps.queue?.process<RevalidationDispatchJob>(REVALIDATION_DISPATCH_QUEUE, async (job) => {
    try {
      await runRevalidationDispatch(deps.db, job.data.siteId, job.data.collection);
    } catch (error) {
      console.error('[revalidation-dispatch] job failed', {
        siteId: job.data.siteId,
        collection: job.data.collection,
        error,
      });
      throw error;
    }
  });
}
