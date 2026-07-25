import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  FeedReader,
  InMemoryCdcEventStore,
  CursorExpiredError,
  eventKeyset,
  type StoredChangeEvent,
} from '../modules/cdc/change-feed/feed-reader';
import { compareKeyset } from '../modules/cdc/change-feed/subscription-state';
import { decodeCdcCursor, type CdcOperation } from '@lumibase/shared';

/**
 * Feature: cdc-extension-integration, Property 2: Cursor pagination gap-free
 *
 * For any event set and any page size, walking the feed via `nextCursor`
 * SHALL return exactly the matching events, in keyset order, with no
 * duplicates and no gaps (Req 2.1, 2.2).
 *
 * Feature: cdc-extension-integration, Property 8: Filter đúng và đủ
 *
 * For any (collections × operations) filter, the pages SHALL contain exactly
 * the events matching the filter — none missing, none extra (Req 3.1).
 */

const NOW_MS = 1_900_000_000_000; // fixed clock for determinism
const RETENTION_DAYS = 7;

const OPERATIONS: CdcOperation[] = ['create', 'update', 'delete'];
const COLLECTIONS = ['posts', 'pages', 'products'];

let seq = 0;
function makeEvent(overrides: Partial<StoredChangeEvent>): StoredChangeEvent {
  seq += 1;
  return {
    id: `evt_${String(seq).padStart(6, '0')}_${Math.abs(seq * 2654435761 % 997)}`,
    siteId: 'site_A',
    collection: 'posts',
    itemId: `itm_${seq}`,
    operation: 'create',
    payload: null,
    changedFields: null,
    schemaVersion: 1,
    actorType: 'system',
    actorId: null,
    source: 'system',
    occurredAt: new Date(NOW_MS - 60_000),
    ...overrides,
  };
}

/** Events safely inside the retention window and older than the safety lag. */
const eventArb = fc
  .record({
    collection: fc.constantFrom(...COLLECTIONS),
    operation: fc.constantFrom(...OPERATIONS),
    // within [now - 6 days, now - 10s]
    ageMs: fc.integer({ min: 10_000, max: 6 * 86_400_000 }),
  })
  .map(({ collection, operation, ageMs }) =>
    makeEvent({ collection, operation, occurredAt: new Date(NOW_MS - ageMs) }),
  );

function makeReader(events: StoredChangeEvent[]) {
  const store = new InMemoryCdcEventStore([...events]);
  return new FeedReader({
    store,
    siteId: 'site_A',
    retentionDays: RETENTION_DAYS,
    now: () => new Date(NOW_MS),
  });
}

async function walkFeed(
  reader: FeedReader,
  filters: { collections?: string[]; operations?: CdcOperation[] },
  pageSize: number,
): Promise<StoredChangeEvent[]> {
  const out: StoredChangeEvent[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await reader.read(
      cursor ? decodeCdcCursor(cursor) : null,
      filters,
      pageSize,
    );
    out.push(...page.events);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return out;
}

describe('Feature: cdc-extension-integration, Property 2: Cursor pagination gap-free', () => {
  it('walking with nextCursor yields every event exactly once, in keyset order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(eventArb, { maxLength: 60 }),
        fc.integer({ min: 1, max: 7 }),
        async (events, pageSize) => {
          const reader = makeReader(events);
          const walked = await walkFeed(reader, {}, pageSize);

          const expected = [...events].sort((a, b) =>
            compareKeyset(eventKeyset(a), eventKeyset(b)),
          );
          expect(walked.map((e) => e.id)).toEqual(expected.map((e) => e.id));
          // no duplicates
          expect(new Set(walked.map((e) => e.id)).size).toBe(walked.length);
          // strictly ascending keyset
          for (let i = 1; i < walked.length; i++) {
            expect(
              compareKeyset(eventKeyset(walked[i - 1]!), eventKeyset(walked[i]!)),
            ).toBeLessThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('safety lag: events younger than the lag are invisible until the clock advances', async () => {
    const old = makeEvent({ occurredAt: new Date(NOW_MS - 60_000) });
    const fresh = makeEvent({ occurredAt: new Date(NOW_MS - 500) }); // < 2s lag
    const reader = makeReader([old, fresh]);
    const page = await reader.read(null, {}, 100);
    expect(page.events.map((e) => e.id)).toEqual([old.id]);
  });

  it('cursor older than the retention floor throws CursorExpiredError with earliestCursor (Req 2.5)', async () => {
    const event = makeEvent({ occurredAt: new Date(NOW_MS - 60_000) });
    const reader = makeReader([event]);
    const expired = {
      occurredAtMs: NOW_MS - (RETENTION_DAYS + 1) * 86_400_000,
      eventId: 'gone',
    };
    await expect(reader.read(expired, {}, 10)).rejects.toBeInstanceOf(CursorExpiredError);
    try {
      await reader.read(expired, {}, 10);
    } catch (err) {
      expect((err as CursorExpiredError).earliestCursor).not.toBeNull();
    }
  });
});

describe('Feature: cdc-extension-integration, Property 8: Filter đúng và đủ', () => {
  it('pages contain exactly the events matching (collections × operations)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(eventArb, { maxLength: 60 }),
        fc.subarray(COLLECTIONS),
        fc.subarray(OPERATIONS),
        fc.integer({ min: 1, max: 7 }),
        async (events, collections, operations, pageSize) => {
          const reader = makeReader(events);
          const filters = {
            collections: collections.length ? collections : undefined,
            operations: operations.length ? operations : undefined,
          };
          const walked = await walkFeed(reader, filters, pageSize);

          const expected = events
            .filter((e) => (filters.collections ? filters.collections.includes(e.collection) : true))
            .filter((e) => (filters.operations ? filters.operations.includes(e.operation) : true))
            .sort((a, b) => compareKeyset(eventKeyset(a), eventKeyset(b)));

          expect(walked.map((e) => e.id)).toEqual(expected.map((e) => e.id));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('tenant isolation at the store: site B events never appear in site A pages', async () => {
    const a = makeEvent({ siteId: 'site_A' });
    const b = makeEvent({ siteId: 'site_B' });
    const reader = makeReader([a, b]);
    const page = await reader.read(null, {}, 100);
    expect(page.events.map((e) => e.siteId)).toEqual(['site_A']);
  });
});
