/**
 * Manual ordering (#690).
 *
 * A collection opts in with `meta.manualSort: true`. Its items are then listed
 * by the `sort` column (ascending) when the caller asks for no other order, new
 * items go to the end, and the delivery API uses the same default.
 *
 * `sort` stays an integer, spaced by {@link SORT_GAP}. Moving one item between
 * two neighbours writes only that item, at the midpoint of the gap — one write.
 * When the gap is used up (neighbours are adjacent integers, or every row is
 * still at the default `0`), the collection is renumbered once, in order, with
 * fresh gaps; the order of every other row is unchanged by that.
 *
 * The moved item itself is written through `ItemService.patch` (with the
 * caller's `update` permission and `sort` field access, realtime, CDC and
 * hooks), with `saveRevision: false` supplied by the caller's service so a drag
 * does not add revisions. Renumbering is a structural, order-preserving side
 * effect done in one SQL statement, scoped by site and collection.
 */
import { and, asc, desc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { items, scopeSite, type Database } from '@lumibase/database';
import { ItemServiceError, type ItemRow, type ItemService } from './item-service';

export const SORT_GAP = 1024;

export function isManualSort(meta: unknown): boolean {
  return Boolean(meta && typeof meta === 'object' && (meta as Record<string, unknown>).manualSort === true);
}

/** ORDER BY for a manual-sort collection: `sort`, then creation, then id (total order). */
export function manualSortOrder(): SQL[] {
  return [asc(items.sort), asc(items.createdAt), asc(items.id)];
}

/** Integer strictly between `prev` and `next`, or null when there is none. */
export function midpoint(prev: number | null, next: number | null): number | null {
  if (prev === null && next === null) return 0;
  if (prev === null) return next! - SORT_GAP;
  if (next === null) return prev + SORT_GAP;
  if (next - prev < 2) return null;
  return Math.floor((prev + next) / 2);
}

export type ReorderTarget = { after: string | null } | { before: string };

export interface ReorderDeps {
  db: Database;
  siteId: string;
  items: ItemService;
}

interface Key {
  id: string;
  sort: number;
  createdAt: Date;
}

export class ItemReorderService {
  constructor(private readonly deps: ReorderDeps) {}

  /** Place `id` right after `after` (null = first) or right before `before`. */
  async reorder(collection: string, collectionId: string, id: string, target: ReorderTarget): Promise<ItemRow> {
    // Readable to the caller, or 404 — before any write.
    await this.deps.items.detail(collection, id);
    const anchorId = 'before' in target ? target.before : target.after;
    if (anchorId === id) {
      throw new ItemServiceError('INVALID_REORDER', 'An item cannot be placed next to itself.', 400);
    }
    if (anchorId) await this.deps.items.detail(collection, anchorId);

    let sortValue = await this.slot(collectionId, id, target);
    if (sortValue === null) {
      await this.renumber(collectionId);
      sortValue = await this.slot(collectionId, id, target);
    }
    if (sortValue === null) {
      throw new ItemServiceError('REORDER_FAILED', 'Could not find a slot for the item.', 409);
    }
    return (await this.deps.items.patch(collection, id, { sort: sortValue })) as ItemRow;
  }

  /** New `sort` for the moved item, or null when the gap is exhausted. */
  private async slot(collectionId: string, id: string, target: ReorderTarget): Promise<number | null> {
    if ('before' in target) {
      const next = await this.key(collectionId, target.before);
      const prev = await this.neighbour(collectionId, id, next, 'prev');
      if (prev && prev.sort === next.sort) return null;
      return midpoint(prev?.sort ?? null, next.sort);
    }
    if (target.after === null) {
      const first = await this.neighbour(collectionId, id, null, 'first');
      return midpoint(null, first?.sort ?? null);
    }
    const prev = await this.key(collectionId, target.after);
    const next = await this.neighbour(collectionId, id, prev, 'next');
    if (next && next.sort === prev.sort) return null;
    return midpoint(prev.sort, next?.sort ?? null);
  }

  private scope(collectionId: string): SQL | undefined {
    return and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, collectionId), isNull(items.deletedAt));
  }

  private async key(collectionId: string, id: string): Promise<Key> {
    const [row] = await this.deps.db
      .select({ id: items.id, sort: items.sort, createdAt: items.createdAt })
      .from(items)
      .where(and(this.scope(collectionId), eq(items.id, id)))
      .limit(1);
    if (!row) throw new ItemServiceError('NOT_FOUND', `Item "${id}" not found.`, 404);
    return row;
  }

  /**
   * The row just before/after `anchor` in manual order, skipping the moved
   * item. Compared as a row tuple against the anchor's own row in SQL, so the
   * microsecond `created_at` tie-breaker is never round-tripped through a JS Date.
   */
  private async neighbour(
    collectionId: string,
    movingId: string,
    anchor: Key | null,
    which: 'prev' | 'next' | 'first',
  ): Promise<Key | null> {
    const anchorRow = anchor
      ? sql`(select a.sort, a.created_at, a.id from lumibase_items a where a.site_id = ${this.deps.siteId} and a.id = ${anchor.id})`
      : null;
    const tuple = sql`(${items.sort}, ${items.createdAt}, ${items.id})`;
    const position =
      which === 'first' || !anchorRow
        ? undefined
        : which === 'next'
          ? sql`${tuple} > ${anchorRow}`
          : sql`${tuple} < ${anchorRow}`;
    const order = which === 'prev'
      ? [desc(items.sort), desc(items.createdAt), desc(items.id)]
      : manualSortOrder();
    const [row] = await this.deps.db
      .select({ id: items.id, sort: items.sort, createdAt: items.createdAt })
      .from(items)
      .where(and(this.scope(collectionId), ne(items.id, movingId), position))
      .orderBy(...order)
      .limit(1);
    return row ?? null;
  }

  /** Re-space every live row of the collection by SORT_GAP, keeping the order. */
  private async renumber(collectionId: string): Promise<void> {
    await this.deps.db.execute(sql`
      UPDATE lumibase_items i
         SET sort = ranked.rn * ${SORT_GAP}
        FROM (
          SELECT id, row_number() OVER (ORDER BY sort, created_at, id) AS rn
            FROM lumibase_items
           WHERE site_id = ${this.deps.siteId}
             AND collection_id = ${collectionId}
             AND deleted_at IS NULL
        ) ranked
       WHERE i.id = ranked.id
         AND i.site_id = ${this.deps.siteId}
         AND i.collection_id = ${collectionId}
    `);
  }
}

/** `sort` for a new item appended to a manual-sort collection. */
export async function nextManualSort(db: Database, siteId: string, collectionId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${items.sort})` })
    .from(items)
    .where(and(scopeSite(items.siteId, siteId), eq(items.collectionId, collectionId), isNull(items.deletedAt)));
  return (row?.max ?? 0) + SORT_GAP;
}
