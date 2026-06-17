import { and, asc, eq, isNotNull, isNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { collections, items, settings, scopeSite, type Database } from '@lumibase/database';
import type { QueueProvider } from '@lumibase/runtime';
import { dispatchRevalidation, parseTargets } from './revalidation';

/**
 * Content scheduler (regulated-content-readiness task 7; Req 7.3, 7.4, 7.6, 7.7).
 *
 * Mirrors the veto-commit worker model (design §8): the primary path is a
 * periodic tick on the existing QueueProvider / Flows schedule trigger, with a
 * safety-net sweep for items the queue missed (catch-up after downtime).
 *
 * Idempotency (Req 7.6): each transition is a conditional UPDATE guarded by the
 * source state (`status != target`). Only rows actually flipped trigger
 * revalidation, so re-running over the same timestamp is a no-op and never
 * double-fires side-effects.
 */

export const SCHEDULER_QUEUE = 'content-scheduler';

export interface SchedulerDeps {
  db: Database;
  queue?: QueueProvider;
}

export interface SchedulerTickResult {
  published: number;
  unpublished: number;
}

/** Resolve a collection's unpublish target (`archived` default, or `draft`). */
function unpublishTarget(meta: unknown): 'archived' | 'draft' {
  const m = meta as Record<string, unknown> | null;
  return m?.unpublishTarget === 'draft' ? 'draft' : 'archived';
}

/** Best-effort revalidation of collection tags for a site (Req 7.3, 7.4). */
async function revalidate(db: Database, siteId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  try {
    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.siteId, siteId), eq(settings.key, 'revalidation.targets')));
    const targets = parseTargets(row?.value);
    if (targets.length > 0) await dispatchRevalidation(targets, tags);
  } catch {
    // Revalidation is best-effort; the state transition has already committed.
  }
}

/** Map collectionId → name for revalidation tags. */
async function collectionNames(db: Database, siteId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: collections.id, name: collections.name })
    .from(collections)
    .where(scopeSite(collections.siteId, siteId));
  for (const r of rows) if (ids.includes(r.id)) map.set(r.id, r.name);
  return map;
}

/**
 * Publish items whose `publishAt` is due (Req 7.3). Flips not-yet-published
 * items in their Publish_Window to `published` and revalidates per collection.
 */
export async function sweepDuePublish(deps: SchedulerDeps, now = new Date()): Promise<number> {
  const due = await deps.db
    .select({ id: items.id, siteId: items.siteId, collectionId: items.collectionId })
    .from(items)
    .where(
      and(
        ne(items.status, 'published'),
        isNull(items.deletedAt),
        isNotNull(items.publishAt),
        lte(items.publishAt, now),
        // Respect any unpublish bound that has not yet elapsed.
        sql`(${items.unpublishAt} is null or ${items.unpublishAt} > ${now})` as SQL,
      ),
    )
    .orderBy(asc(items.publishAt))
    .limit(200);

  if (due.length === 0) return 0;

  const ids = due.map((d) => d.id);
  // Conditional flip — only rows still not published are affected (idempotent).
  for (const row of due) {
    await deps.db
      .update(items)
      .set({ status: 'published', editorialState: 'published', updatedAt: new Date() })
      .where(and(eq(items.id, row.id), ne(items.status, 'published')));
  }

  // Revalidate affected collections once.
  const bySite = new Map<string, Set<string>>();
  for (const row of due) {
    if (!bySite.has(row.siteId)) bySite.set(row.siteId, new Set());
    bySite.get(row.siteId)!.add(row.collectionId);
  }
  for (const [siteId, collIds] of bySite) {
    const names = await collectionNames(deps.db, siteId, [...collIds]);
    await revalidate(deps.db, siteId, [...names.values()]);
  }
  return ids.length;
}

/**
 * Unpublish items whose `unpublishAt` has elapsed (Req 7.4). Moves published
 * items to the collection's unpublish target (archived|draft).
 */
export async function sweepDueUnpublish(deps: SchedulerDeps, now = new Date()): Promise<number> {
  const due = await deps.db
    .select({ id: items.id, siteId: items.siteId, collectionId: items.collectionId })
    .from(items)
    .where(
      and(
        eq(items.status, 'published'),
        isNull(items.deletedAt),
        isNotNull(items.unpublishAt),
        lte(items.unpublishAt, now),
      ),
    )
    .orderBy(asc(items.unpublishAt))
    .limit(200);

  if (due.length === 0) return 0;

  const collIdsBySite = new Map<string, Set<string>>();
  for (const row of due) {
    // Resolve target per collection meta.
    const [coll] = await deps.db
      .select({ meta: collections.meta })
      .from(collections)
      .where(eq(collections.id, row.collectionId))
      .limit(1);
    const target = unpublishTarget(coll?.meta);
    await deps.db
      .update(items)
      .set({
        status: target,
        editorialState: target === 'draft' ? 'draft' : null,
        updatedAt: new Date(),
      })
      .where(and(eq(items.id, row.id), eq(items.status, 'published')));
    if (!collIdsBySite.has(row.siteId)) collIdsBySite.set(row.siteId, new Set());
    collIdsBySite.get(row.siteId)!.add(row.collectionId);
  }

  for (const [siteId, collIds] of collIdsBySite) {
    const names = await collectionNames(deps.db, siteId, [...collIds]);
    await revalidate(deps.db, siteId, [...names.values()]);
  }
  return due.length;
}

/** One scheduler tick: apply due publishes then due unpublishes (Req 7.6). */
export async function runSchedulerTick(deps: SchedulerDeps, now = new Date()): Promise<SchedulerTickResult> {
  const published = await sweepDuePublish(deps, now);
  const unpublished = await sweepDueUnpublish(deps, now);
  return { published, unpublished };
}

/** Long-lived runtime consumer (Docker/Node). Mirrors the veto worker. */
export function registerSchedulerWorker(deps: SchedulerDeps): void {
  deps.queue?.process(SCHEDULER_QUEUE, async () => {
    await runSchedulerTick(deps);
  });
}
