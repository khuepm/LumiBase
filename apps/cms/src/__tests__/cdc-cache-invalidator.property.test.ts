import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import {
  CacheInvalidator,
  InMemoryCacheInvalidatorLogger,
  deriveCacheKey,
  cacheActionForOperation,
  DEDUP_WINDOW_MS,
  DEFAULT_CACHE_KEY_PREFIX,
  type CdcChangeEvent,
  type CdcOperation,
} from '../modules/cdc/cache-invalidator';
import type { CacheProvider } from '@lumibase/runtime';

/**
 * Feature: clickhouse-cdc, Property 11: Cache invalidation correctness by
 * operation type
 *
 * For any CDC change event (INSERT, UPDATE, or DELETE) on a configuration
 * table, the Cache Invalidator SHALL derive the correct cache key
 * (`config:<table>:<recordId>`) and apply the corresponding Redis operation:
 * SET for INSERT (pre-warm), SET for UPDATE (refresh), and DEL for DELETE.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3**
 */

/**
 * Feature: clickhouse-cdc, Property 12: Cache event deduplication within time
 * window
 *
 * For any cache key that receives multiple consecutive UPDATE events within a
 * 1-second window, the Cache Invalidator SHALL collapse them into a single
 * refresh carrying the latest state. An intervening INSERT or DELETE for that
 * key is processed immediately (flushing any pending UPDATE first) so that no
 * INSERT/DELETE is dropped and per-key operation ordering is preserved.
 *
 * **Validates: Requirements 5.6**
 */

/**
 * Feature: clickhouse-cdc, Property 13: Cache event queue ordering and replay
 *
 * For any sequence of invalidation events queued during a Redis outage, when
 * connectivity is restored the events SHALL be replayed in their original
 * chronological (FIFO) order.
 *
 * **Validates: Requirements 5.4**
 */

/**
 * Feature: clickhouse-cdc, Property 14: Cache invalidation log completeness
 *
 * For any invalidation event processed by the Cache Invalidator, the emitted
 * log entry SHALL contain the affected table name, record identifier, and
 * operation type.
 *
 * **Validates: Requirements 5.8**
 */

// ── test doubles ───────────────────────────────────────────────────────────

interface AppliedOp {
  readonly kind: 'SET' | 'DEL';
  readonly key: string;
  readonly value?: string;
}

/**
 * A {@link CacheProvider} that records the ordered sequence of operations it
 * applies and can simulate a Redis outage (operations reject while
 * unavailable). Unlike `InMemoryCacheProvider`, it is NOT recognised by the
 * invalidator's default availability probe, so tests pass an explicit
 * `isCacheAvailable` based on {@link isAvailable}.
 */
class RecordingCacheProvider implements CacheProvider {
  readonly applied: AppliedOp[] = [];
  readonly store = new Map<string, string>();
  private available = true;

  setAvailable(available: boolean): void {
    this.available = available;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async get<T = string>(key: string): Promise<T | null> {
    if (!this.available) {
      throw new Error('Redis unavailable');
    }
    return (this.store.get(key) ?? null) as T | null;
  }

  async set(key: string, value: string, _options?: { ttl?: number }): Promise<void> {
    if (!this.available) {
      throw new Error('Redis unavailable');
    }
    this.store.set(key, value);
    this.applied.push({ kind: 'SET', key, value });
  }

  async delete(key: string): Promise<void> {
    if (!this.available) {
      throw new Error('Redis unavailable');
    }
    this.store.delete(key);
    this.applied.push({ kind: 'DEL', key });
  }

  async increment(key: string, by = 1): Promise<number> {
    const next = Number(this.store.get(key) ?? '0') + by;
    this.store.set(key, String(next));
    return next;
  }

  async getEntry<T>(key: string) {
    if (!this.available) return { state: 'unavailable' as const };
    const raw = this.store.get(key);
    if (raw === undefined) return { state: 'miss' as const };
    return { state: 'hit' as const, value: raw as T };
  }

  async setNegative(key: string, options?: { ttl?: number }) {
    await this.set(key, JSON.stringify({ __lumi: 'neg', v: 1 }), options);
  }
}

/** Mirror of the invalidator's payload serialization (`JSON.stringify(p ?? null)`). */
function serialize(payload: Record<string, unknown> | undefined): string {
  return JSON.stringify(payload ?? null);
}

// ── arbitraries ──────────────────────────────────────────────────────────

/** A lowercase table identifier (optionally schema-qualified-ish). */
const arbTable = fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/);

/** A non-empty record identifier. */
const arbRecordId = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/);

/** Any CDC operation. */
const arbOperation = fc.constantFrom<CdcOperation>('INSERT', 'UPDATE', 'DELETE');

/** An optional row payload. */
const arbPayload = fc.option(
  fc.dictionary(
    fc.string({ minLength: 1, maxLength: 8 }),
    fc.oneof(fc.string(), fc.integer(), fc.boolean()),
    { maxKeys: 5 },
  ),
  { nil: undefined },
);

// ── Property 11 ────────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 11: Cache invalidation correctness by operation type', () => {
  it('derives config:<table>:<recordId> and maps operations to SET/SET/DEL', () => {
    return fc.assert(
      fc.asyncProperty(
        arbTable,
        arbRecordId,
        arbOperation,
        arbPayload,
        async (table, recordId, operation, payload) => {
          const provider = new RecordingCacheProvider();
          const inv = new CacheInvalidator({
            cache: provider,
            isCacheAvailable: () => provider.isAvailable(),
            disableAutoFlush: true,
          });

          const key = deriveCacheKey(table, recordId);
          // Pure key derivation + action mapping.
          expect(key).toBe(`${DEFAULT_CACHE_KEY_PREFIX}:${table}:${recordId}`);
          expect(cacheActionForOperation(operation)).toBe(
            operation === 'DELETE' ? 'DEL' : 'SET',
          );

          // For DELETE to be observable, the key must exist beforehand.
          if (operation === 'DELETE') {
            provider.store.set(key, 'preexisting');
          }

          const event: CdcChangeEvent = {
            table,
            recordId,
            operation,
            payload,
            timestamp: 0,
          };
          await inv.handleEvent(event);
          // UPDATE is held in the dedup window; flush applies it.
          await inv.flush();

          // Exactly one Redis operation, at the derived key.
          expect(provider.applied).toHaveLength(1);
          if (operation === 'DELETE') {
            expect(provider.applied[0]).toEqual({ kind: 'DEL', key });
            expect(provider.store.has(key)).toBe(false);
          } else {
            expect(provider.applied[0]).toEqual({
              kind: 'SET',
              key,
              value: serialize(payload),
            });
            expect(provider.store.get(key)).toBe(serialize(payload));
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 12 ────────────────────────────────────────────────────────────

/**
 * Reference model for a single key's resolved cache operations, assuming every
 * UPDATE falls inside the dedup window (the generators guarantee this). Used as
 * an oracle for ordering / non-dropping of INSERT and DELETE events.
 */
function modelOps(
  key: string,
  events: readonly CdcChangeEvent[],
): AppliedOp[] {
  const ops: AppliedOp[] = [];
  let pending: string | null = null; // latest collapsed UPDATE value

  for (const e of events) {
    if (e.operation === 'UPDATE') {
      // Consecutive UPDATEs within the window collapse into the latest state.
      pending = serialize(e.payload);
      continue;
    }
    // INSERT / DELETE flush any pending UPDATE first, then apply immediately.
    if (pending !== null) {
      ops.push({ kind: 'SET', key, value: pending });
      pending = null;
    }
    ops.push(
      e.operation === 'DELETE'
        ? { kind: 'DEL', key }
        : { kind: 'SET', key, value: serialize(e.payload) },
    );
  }
  if (pending !== null) {
    ops.push({ kind: 'SET', key, value: pending });
  }
  return ops;
}

describe('Feature: clickhouse-cdc, Property 12: Cache event deduplication within time window', () => {
  it('collapses consecutive UPDATEs within the window into a single SET of the latest state', () => {
    return fc.assert(
      fc.asyncProperty(
        arbTable,
        arbRecordId,
        // 2+ UPDATEs, each with an in-window offset from a shared base.
        fc.array(fc.integer({ min: 0, max: DEDUP_WINDOW_MS }), {
          minLength: 2,
          maxLength: 8,
        }),
        async (table, recordId, offsetsRaw) => {
          const provider = new RecordingCacheProvider();
          const inv = new CacheInvalidator({
            cache: provider,
            isCacheAvailable: () => provider.isAvailable(),
            disableAutoFlush: true,
          });
          const key = deriveCacheKey(table, recordId);
          const base = 1_000_000;
          const offsets = [...offsetsRaw].sort((a, b) => a - b);

          const events: CdcChangeEvent[] = offsets.map((off, i) => ({
            table,
            recordId,
            operation: 'UPDATE' as const,
            payload: { seq: i },
            timestamp: base + off,
          }));

          for (const e of events) {
            await inv.handleEvent(e);
          }

          // While the window is open, the UPDATE is held (not yet dispatched).
          expect(inv.getPendingUpdateCount()).toBe(1);
          expect(provider.applied).toHaveLength(0);

          await inv.flush();

          // Collapsed into exactly one SET carrying the LATEST state.
          const lastValue = serialize({ seq: events.length - 1 });
          expect(provider.applied).toEqual([
            { kind: 'SET', key, value: lastValue },
          ]);
          expect(provider.store.get(key)).toBe(lastValue);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('processes intervening INSERT/DELETE immediately (flushing pending UPDATE first) with no drops or reordering', () => {
    return fc.assert(
      fc.asyncProperty(
        arbTable,
        arbRecordId,
        fc.array(
          fc.record({
            op: arbOperation,
            offset: fc.integer({ min: 0, max: DEDUP_WINDOW_MS }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (table, recordId, specsRaw) => {
          const provider = new RecordingCacheProvider();
          const inv = new CacheInvalidator({
            cache: provider,
            isCacheAvailable: () => provider.isAvailable(),
            disableAutoFlush: true,
          });
          const key = deriveCacheKey(table, recordId);
          const base = 1_000_000;

          // Submit in chronological order; all timestamps share one window.
          const specs = [...specsRaw].sort((a, b) => a.offset - b.offset);
          const events: CdcChangeEvent[] = specs.map((s, i) => ({
            table,
            recordId,
            operation: s.op,
            payload: { seq: i },
            timestamp: base + s.offset,
          }));

          for (const e of events) {
            await inv.handleEvent(e);
          }
          await inv.flush();

          // Resolved ops match the reference model exactly: ordering preserved
          // and pending UPDATEs flushed ahead of any INSERT/DELETE.
          expect(provider.applied).toEqual(modelOps(key, events));

          // No INSERT/DELETE is dropped: every DELETE yields a DEL.
          const deleteCount = events.filter(
            (e) => e.operation === 'DELETE',
          ).length;
          expect(
            provider.applied.filter((o) => o.kind === 'DEL'),
          ).toHaveLength(deleteCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 13 ────────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 13: Cache event queue ordering and replay', () => {
  it('replays events queued during a Redis outage in original FIFO order', () => {
    return fc.assert(
      fc.asyncProperty(
        // INSERT/DELETE only: these are the operations buffered in the FIFO
        // outage queue (UPDATEs are instead held in the dedup window).
        fc.array(
          fc.record({
            table: arbTable,
            recordId: arbRecordId,
            op: fc.constantFrom<CdcOperation>('INSERT', 'DELETE'),
            offset: fc.nat(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (specsRaw) => {
          const provider = new RecordingCacheProvider();
          const inv = new CacheInvalidator({
            cache: provider,
            isCacheAvailable: () => provider.isAvailable(),
            disableAutoFlush: true,
          });

          const base = 1_000_000;
          // Chronological submission order.
          const specs = [...specsRaw].sort((a, b) => a.offset - b.offset);
          const events: CdcChangeEvent[] = specs.map((s, i) => ({
            table: s.table,
            recordId: s.recordId,
            operation: s.op,
            payload: { seq: i },
            timestamp: base + s.offset + i,
          }));

          // Simulate the outage: nothing should reach Redis yet.
          provider.setAvailable(false);
          for (const e of events) {
            await inv.handleEvent(e);
          }
          expect(provider.applied).toHaveLength(0);
          expect(inv.getQueueDepth()).toBe(events.length);

          // Reconnect and replay.
          provider.setAvailable(true);
          await inv.flush();

          const expected: AppliedOp[] = events.map((e, i) =>
            e.operation === 'DELETE'
              ? { kind: 'DEL', key: deriveCacheKey(e.table, e.recordId) }
              : {
                  kind: 'SET',
                  key: deriveCacheKey(e.table, e.recordId),
                  value: serialize({ seq: i }),
                },
          );

          expect(provider.applied).toEqual(expected);
          expect(inv.getQueueDepth()).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 14 ────────────────────────────────────────────────────────────

describe('Feature: clickhouse-cdc, Property 14: Cache invalidation log completeness', () => {
  it('emits one event log entry per handled event with table, recordId, and operation', () => {
    return fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            table: arbTable,
            recordId: arbRecordId,
            operation: arbOperation,
            payload: arbPayload,
          }),
          { minLength: 1, maxLength: 15 },
        ),
        async (specs) => {
          const logger = new InMemoryCacheInvalidatorLogger();
          const inv = new CacheInvalidator({
            logger,
            disableAutoFlush: true,
          });

          const events: CdcChangeEvent[] = specs.map((s, i) => ({
            table: s.table,
            recordId: s.recordId,
            operation: s.operation,
            payload: s.payload,
            timestamp: 1_000_000 + i,
          }));

          for (const e of events) {
            await inv.handleEvent(e);
          }

          const eventLogs = logger.entriesOfType('event');
          expect(eventLogs).toHaveLength(events.length);

          events.forEach((e, i) => {
            const entry = eventLogs[i]!;
            expect(entry.table).toBe(e.table);
            expect(entry.recordId).toBe(e.recordId);
            expect(entry.operation).toBe(e.operation);
            expect(entry.key).toBe(deriveCacheKey(e.table, e.recordId));
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
