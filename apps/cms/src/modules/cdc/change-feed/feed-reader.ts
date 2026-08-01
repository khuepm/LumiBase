/**
 * Change Feed reader — keyset pagination over the outbox (Req 2.1–2.5).
 *
 * Paging semantics live HERE, against a small `CdcEventStore` port, so the
 * gap-free/filter properties (P2, P8) are testable on the in-memory store
 * (repo `InMemory*` convention) while production reads go through Drizzle
 * with an equivalent SQL keyset predicate.
 *
 * Two ordering rules from the design apply to every read path:
 * - order/compare by the composite keyset `(occurred_at, id)` (§3.1);
 * - a **safety lag** (default 2s, §6): never read past `now - lag`, so a
 *   long transaction holding an earlier `now()` cannot be overtaken and
 *   then skipped.
 */

import { and, asc, count, desc, eq, gt, inArray, lt, or, type SQL } from 'drizzle-orm';
import { cdcChangeEvents, type Database } from '@lumibase/database';
import {
  encodeCdcCursor,
  type CdcCursor,
  type CdcOperation,
} from '@lumibase/contracts/schemas';
import { compareKeyset } from './subscription-state';

export const SAFETY_LAG_MS = 2_000;

export interface StoredChangeEvent {
  id: string;
  siteId: string;
  /** Resource kind — defaults to 'item' for rows written before this column. */
  resource?: string;
  collection: string;
  itemId: string;
  operation: CdcOperation;
  payload: Record<string, unknown> | null;
  changedFields: string[] | null;
  schemaVersion: number;
  actorType: string;
  actorId: string | null;
  source: string;
  occurredAt: Date;
}

export interface FeedFilters {
  collections?: string[];
  operations?: CdcOperation[];
}

/** Read port over the outbox — Drizzle in production, in-memory in tests. */
export interface CdcEventStore {
  /**
   * Events strictly after `after` (exclusive keyset), matching the filters,
   * with `occurredAt < notAfter`, ordered by `(occurredAt, id)` asc, at most
   * `limit` rows.
   */
  listAfter(
    siteId: string,
    after: CdcCursor | null,
    filters: FeedFilters,
    limit: number,
    notAfter: Date,
  ): Promise<StoredChangeEvent[]>;
  /** Earliest event still retained for the site (any filter), or null. */
  earliest(siteId: string): Promise<StoredChangeEvent | null>;
  /** Latest event for the site, or null — the feed head (lag denominator). */
  latest(siteId: string): Promise<StoredChangeEvent | null>;
  /** Number of events strictly after `after` (null = everything). Drives Req 3.5 lag. */
  countAfter(siteId: string, after: CdcCursor | null): Promise<number>;
}

export function eventKeyset(event: Pick<StoredChangeEvent, 'id' | 'occurredAt'>): CdcCursor {
  return { occurredAtMs: event.occurredAt.getTime(), eventId: event.id };
}

export class InMemoryCdcEventStore implements CdcEventStore {
  constructor(private readonly events: StoredChangeEvent[] = []) {}

  add(event: StoredChangeEvent): void {
    this.events.push(event);
  }

  async listAfter(
    siteId: string,
    after: CdcCursor | null,
    filters: FeedFilters,
    limit: number,
    notAfter: Date,
  ): Promise<StoredChangeEvent[]> {
    return this.events
      .filter((e) => e.siteId === siteId)
      .filter((e) => e.occurredAt.getTime() < notAfter.getTime())
      .filter((e) => (after ? compareKeyset(eventKeyset(e), after) > 0 : true))
      .filter((e) =>
        filters.collections?.length ? filters.collections.includes(e.collection) : true,
      )
      .filter((e) =>
        filters.operations?.length ? filters.operations.includes(e.operation) : true,
      )
      .sort((a, b) => compareKeyset(eventKeyset(a), eventKeyset(b)))
      .slice(0, limit);
  }

  async earliest(siteId: string): Promise<StoredChangeEvent | null> {
    const site = this.events
      .filter((e) => e.siteId === siteId)
      .sort((a, b) => compareKeyset(eventKeyset(a), eventKeyset(b)));
    return site[0] ?? null;
  }

  async latest(siteId: string): Promise<StoredChangeEvent | null> {
    const site = this.events
      .filter((e) => e.siteId === siteId)
      .sort((a, b) => compareKeyset(eventKeyset(a), eventKeyset(b)));
    return site[site.length - 1] ?? null;
  }

  async countAfter(siteId: string, after: CdcCursor | null): Promise<number> {
    return this.events
      .filter((e) => e.siteId === siteId)
      .filter((e) => (after ? compareKeyset(eventKeyset(e), after) > 0 : true)).length;
  }
}

export class DrizzleCdcEventStore implements CdcEventStore {
  constructor(private readonly db: Database) {}

  async listAfter(
    siteId: string,
    after: CdcCursor | null,
    filters: FeedFilters,
    limit: number,
    notAfter: Date,
  ): Promise<StoredChangeEvent[]> {
    const conditions: (SQL | undefined)[] = [
      eq(cdcChangeEvents.siteId, siteId),
      lt(cdcChangeEvents.occurredAt, notAfter),
    ];
    if (after) {
      const afterDate = new Date(after.occurredAtMs);
      conditions.push(
        or(
          gt(cdcChangeEvents.occurredAt, afterDate),
          and(
            eq(cdcChangeEvents.occurredAt, afterDate),
            gt(cdcChangeEvents.id, after.eventId),
          ),
        ),
      );
    }
    if (filters.collections?.length) {
      conditions.push(inArray(cdcChangeEvents.collection, filters.collections));
    }
    if (filters.operations?.length) {
      conditions.push(inArray(cdcChangeEvents.operation, filters.operations));
    }
    const rows = await this.db
      .select()
      .from(cdcChangeEvents)
      .where(and(...conditions))
      .orderBy(asc(cdcChangeEvents.occurredAt), asc(cdcChangeEvents.id))
      .limit(limit);
    return rows as unknown as StoredChangeEvent[];
  }

  async earliest(siteId: string): Promise<StoredChangeEvent | null> {
    const [row] = await this.db
      .select()
      .from(cdcChangeEvents)
      .where(eq(cdcChangeEvents.siteId, siteId))
      .orderBy(asc(cdcChangeEvents.occurredAt), asc(cdcChangeEvents.id))
      .limit(1);
    return (row as unknown as StoredChangeEvent) ?? null;
  }

  async latest(siteId: string): Promise<StoredChangeEvent | null> {
    const [row] = await this.db
      .select()
      .from(cdcChangeEvents)
      .where(eq(cdcChangeEvents.siteId, siteId))
      .orderBy(desc(cdcChangeEvents.occurredAt), desc(cdcChangeEvents.id))
      .limit(1);
    return (row as unknown as StoredChangeEvent) ?? null;
  }

  async countAfter(siteId: string, after: CdcCursor | null): Promise<number> {
    const conditions: (SQL | undefined)[] = [eq(cdcChangeEvents.siteId, siteId)];
    if (after) {
      const afterDate = new Date(after.occurredAtMs);
      conditions.push(
        or(
          gt(cdcChangeEvents.occurredAt, afterDate),
          and(
            eq(cdcChangeEvents.occurredAt, afterDate),
            gt(cdcChangeEvents.id, after.eventId),
          ),
        ),
      );
    }
    const [row] = await this.db
      .select({ n: count() })
      .from(cdcChangeEvents)
      .where(and(...conditions));
    return Number(row?.n ?? 0);
  }
}

/** Thrown when the caller's cursor predates the retention floor (Req 2.5 → 410). */
export class CursorExpiredError extends Error {
  constructor(public readonly earliestCursor: string | null) {
    super('Cursor predates the retention floor');
    this.name = 'CursorExpiredError';
  }
}

export interface FeedPage {
  events: StoredChangeEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FeedReaderDeps {
  store: CdcEventStore;
  siteId: string;
  /** Retention window used for the 410 floor check (Req 2.5). */
  retentionDays: number;
  now?: () => Date;
  safetyLagMs?: number;
}

export class FeedReader {
  constructor(private readonly deps: FeedReaderDeps) {}

  async read(
    cursor: CdcCursor | null,
    filters: FeedFilters,
    limit: number,
  ): Promise<FeedPage> {
    const now = (this.deps.now ?? (() => new Date()))();
    const floorMs = now.getTime() - this.deps.retentionDays * 86_400_000;
    if (cursor && cursor.occurredAtMs < floorMs) {
      const earliest = await this.deps.store.earliest(this.deps.siteId);
      throw new CursorExpiredError(
        earliest ? encodeCdcCursor(eventKeyset(earliest)) : null,
      );
    }

    const notAfter = new Date(now.getTime() - (this.deps.safetyLagMs ?? SAFETY_LAG_MS));
    // Over-fetch by one to compute hasMore without a second query.
    const rows = await this.deps.store.listAfter(
      this.deps.siteId,
      cursor,
      filters,
      limit + 1,
      notAfter,
    );
    const events = rows.slice(0, limit);
    const last = events[events.length - 1];
    return {
      events,
      nextCursor: last ? encodeCdcCursor(eventKeyset(last)) : null,
      hasMore: rows.length > limit,
    };
  }
}
