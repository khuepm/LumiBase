import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  OutboxWriter,
  maskChangeEventPayload,
  feedFlagCacheKey,
  MASKED_VALUE,
  type OutboxWriterDeps,
  type OutboxMutationInput,
  type OutboxAuditWarning,
} from '../modules/cdc/change-feed/outbox-writer';
import type { Database } from '@lumibase/database';

/**
 * Feature: cdc-extension-integration, Property 1: Outbox atomicity
 *
 * For any sequence of committed mutations while the feed is enabled, the
 * writer SHALL append exactly one Change_Event per mutation with matching
 * collection/itemId/operation/actor. With the feed disabled it SHALL append
 * none. A failing insert SHALL emit exactly one `cdc_event_write_failed`
 * audit warning and SHALL NOT throw (Req 1.2, 1.3, 1.5).
 *
 * Feature: cdc-extension-integration, Property 4: Masking bất biến
 *
 * For any payload and any set of sensitive field names, the stored payload
 * SHALL replace every sensitive field's value with `[masked]`, SHALL keep
 * every other entry identical, and SHALL NOT mutate the input (Req 1.4).
 */

// ── Fake DB: captures inserted rows; select() drives the feed flag ───────

interface CapturedEvent {
  siteId: string;
  collection: string;
  itemId: string;
  operation: string;
  payload: Record<string, unknown> | null;
  changedFields: string[] | null;
  actorType: string;
  actorId: string | null;
  source: string;
}

function makeFakeDb(opts: {
  feedEnabled: boolean;
  failInsert?: boolean;
  captured: CapturedEvent[];
}): Database {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () =>
      // First select is the active-subscription probe: one row = enabled.
      opts.feedEnabled ? [{ id: 'sub1' }] : [],
  };
  return {
    select: () => selectChain,
    insert: () => ({
      values: (row: CapturedEvent) => ({
        returning: async () => {
          if (opts.failInsert) throw new Error('insert exploded');
          opts.captured.push(row);
          return [{ id: `evt_${opts.captured.length}` }];
        },
      }),
    }),
  } as unknown as Database;
}

function makeWriter(opts: {
  feedEnabled: boolean;
  failInsert?: boolean;
  captured: CapturedEvent[];
  warnings: OutboxAuditWarning[];
  sensitive?: Set<string>;
}): OutboxWriter {
  const deps: OutboxWriterDeps = {
    db: makeFakeDb(opts),
    siteId: 'site_A',
    getSensitiveFields: async () => opts.sensitive ?? new Set(),
    auditWarn: (w) => {
      opts.warnings.push(w);
    },
  };
  return new OutboxWriter(deps);
}

// ── Arbitraries ─────────────────────────────────────────────────────────

const fieldNameArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);
const scalarArb = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
const payloadArb = fc.dictionary(fieldNameArb, scalarArb, { maxKeys: 10 });

const mutationArb: fc.Arbitrary<OutboxMutationInput> = fc
  .record({
    collection: fc.stringMatching(/^[a-z][a-z0-9_]{0,20}$/),
    itemId: fc.stringMatching(/^[A-Za-z0-9_-]{1,21}$/),
    operation: fc.constantFrom<'create' | 'update' | 'delete'>('create', 'update', 'delete'),
  })
  .chain((base): fc.Arbitrary<OutboxMutationInput> =>
    base.operation === 'delete'
      ? fc.constant<OutboxMutationInput>({ ...base, payload: null })
      : payloadArb.map(
          (payload): OutboxMutationInput => ({ ...base, payload }),
        ),
  );

// ── Property 4 ──────────────────────────────────────────────────────────

describe('Feature: cdc-extension-integration, Property 4: Masking bất biến', () => {
  it('masks exactly the sensitive fields, preserves the rest, never mutates input', () => {
    fc.assert(
      fc.property(
        payloadArb,
        fc.array(fieldNameArb, { maxLength: 6 }).map((a) => new Set(a)),
        (payload, sensitive) => {
          const original = structuredClone(payload);
          const masked = maskChangeEventPayload(payload, sensitive);

          expect(payload).toEqual(original); // input untouched
          expect(Object.keys(masked).sort()).toEqual(Object.keys(payload).sort());
          for (const [key, value] of Object.entries(masked)) {
            if (sensitive.has(key)) {
              expect(value).toBe(MASKED_VALUE);
            } else {
              expect(value).toEqual(payload[key]);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('the stored payload never carries an original sensitive value end-to-end', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .dictionary(fieldNameArb, fc.string({ minLength: 1 }), { minKeys: 1, maxKeys: 8 })
          .chain((payload) => {
            const keys = Object.keys(payload);
            return fc
              .subarray(keys, { minLength: 1 })
              .map((chosen) => ({ payload, sensitive: new Set(chosen) }));
          }),
        async ({ payload, sensitive }) => {
          const captured: CapturedEvent[] = [];
          const writer = makeWriter({ feedEnabled: true, captured, warnings: [], sensitive });
          await writer.write(
            { collection: 'posts', itemId: 'itm1', operation: 'update', payload },
            { type: 'user', id: 'u1' },
            'api',
          );
          const stored = captured[0]!.payload!;
          for (const field of sensitive) {
            // Giá trị gốc không xuất hiện; field vẫn có mặt dưới dạng [masked].
            expect(stored[field]).toBe(MASKED_VALUE);
            expect(stored[field]).not.toBe(payload[field]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 1 ──────────────────────────────────────────────────────────

describe('Feature: cdc-extension-integration, Property 1: Outbox atomicity', () => {
  it('feed ON: exactly one event per mutation with matching fields', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(mutationArb, { maxLength: 20 }), async (mutations) => {
        const captured: CapturedEvent[] = [];
        const writer = makeWriter({ feedEnabled: true, captured, warnings: [] });
        for (const m of mutations) {
          const res = await writer.write(m, { type: 'user', id: 'u1' }, 'api');
          expect(res.written).toBe(true);
        }
        expect(captured).toHaveLength(mutations.length);
        captured.forEach((event, i) => {
          expect(event.siteId).toBe('site_A');
          expect(event.collection).toBe(mutations[i]!.collection);
          expect(event.itemId).toBe(mutations[i]!.itemId);
          expect(event.operation).toBe(mutations[i]!.operation);
          expect(event.actorType).toBe('user');
          expect(event.actorId).toBe('u1');
          if (mutations[i]!.operation === 'delete') expect(event.payload).toBeNull();
        });
      }),
      { numRuns: 100 },
    );
  });

  it('feed OFF: no event is written for any mutation sequence', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(mutationArb, { maxLength: 20 }), async (mutations) => {
        const captured: CapturedEvent[] = [];
        const writer = makeWriter({ feedEnabled: false, captured, warnings: [] });
        for (const m of mutations) {
          const res = await writer.write(m, { type: 'system' }, 'system');
          expect(res.written).toBe(false);
        }
        expect(captured).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('insert failure: exactly one audit warning per mutation, never throws (Req 1.3)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(mutationArb, { minLength: 1, maxLength: 10 }), async (mutations) => {
        const warnings: OutboxAuditWarning[] = [];
        const writer = makeWriter({ feedEnabled: true, failInsert: true, captured: [], warnings });
        for (const m of mutations) {
          const res = await writer.write(m, { type: 'agent', id: 'run1' }, 'agent');
          expect(res).toEqual({ written: false, failed: true });
        }
        expect(warnings).toHaveLength(mutations.length);
        for (const w of warnings) {
          expect(w.event).toBe('cdc_event_write_failed');
          expect(w.siteId).toBe('site_A');
          expect(w.reason).toContain('insert exploded');
        }
      }),
      { numRuns: 50 },
    );
  });
});

// ── Flag cache key tenancy ──────────────────────────────────────────────

describe('cdc-feed flag cache key', () => {
  it('is tenant-prefixed per site (DoD §2b)', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,21}$/),
        fc.stringMatching(/^[A-Za-z0-9_-]{1,21}$/),
        (a, b) => {
          fc.pre(a !== b);
          expect(feedFlagCacheKey(a)).not.toBe(feedFlagCacheKey(b));
          expect(feedFlagCacheKey(a)).toContain(a);
        },
      ),
      { numRuns: 50 },
    );
  });
});
