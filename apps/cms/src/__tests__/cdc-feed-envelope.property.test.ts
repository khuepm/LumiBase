import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  EventEnvelopeSchema,
  CdcFeedQuerySchema,
  CdcFeedSettingsSchema,
  CdcSubscriptionCreateSchema,
  encodeCdcCursor,
  decodeCdcCursor,
} from '@lumibase/contracts';

/**
 * Feature: cdc-extension-integration, Property 3: Envelope round-trip
 *
 * For any valid Change_Event, the built envelope SHALL parse successfully
 * through EventEnvelopeSchema preserving every field, and a reference-mode
 * envelope SHALL never carry `data`. The cursor codec SHALL round-trip any
 * (occurredAtMs, eventId) pair, and decoding SHALL return null (never throw)
 * on malformed tokens.
 *
 * **Validates: Requirements 2.1, design §4 (keyset cursor — phương án B)**
 */

// ── Arbitraries ─────────────────────────────────────────────────────────

/** nanoid-ish id: url-safe alphabet, non-empty. */
const idArb = fc.stringMatching(/^[A-Za-z0-9_-]{1,21}$/);

const operationArb = fc.constantFrom('create', 'update', 'delete' as const);
const actorTypeArb = fc.constantFrom('user', 'api_key', 'agent', 'system' as const);
const sourceArb = fc.constantFrom('api', 'agent', 'flow', 'system' as const);

const cursorPairArb = fc.record({
  occurredAtMs: fc.integer({ min: 0, max: 4102444800000 }), // tới năm 2100
  eventId: idArb,
});

const envelopeArb = fc
  .record({
    id: idArb,
    operation: operationArb,
    siteId: idArb,
    collection: fc.stringMatching(/^[a-z][a-z0-9_]{0,30}$/),
    itemId: idArb,
    occurredAtMs: fc.integer({ min: 0, max: 4102444800000 }),
    actorType: actorTypeArb,
    actorId: fc.option(idArb, { nil: undefined }),
    source: sourceArb,
    changedFields: fc.option(fc.array(fc.stringMatching(/^[a-z_]{1,20}$/), { maxLength: 8 }), {
      nil: undefined,
    }),
    snapshot: fc.boolean(),
  })
  .map((seed) => ({
    id: seed.id,
    type: `items.${seed.operation}`,
    schemaVersion: 1,
    siteId: seed.siteId,
    collection: seed.collection,
    itemId: seed.itemId,
    operation: seed.operation,
    occurredAt: new Date(seed.occurredAtMs).toISOString(),
    actor: { type: seed.actorType, ...(seed.actorId ? { id: seed.actorId } : {}) },
    source: seed.source,
    ...(seed.changedFields ? { changedFields: seed.changedFields } : {}),
    ...(seed.snapshot ? { data: { title: 'masked-snapshot' } } : {}),
    cursor: encodeCdcCursor({ occurredAtMs: seed.occurredAtMs, eventId: seed.id }),
  }));

// ── Property 3 ──────────────────────────────────────────────────────────

describe('Feature: cdc-extension-integration, Property 3: Envelope round-trip', () => {
  it('parses any valid envelope preserving every field', () => {
    fc.assert(
      fc.property(envelopeArb, (envelope) => {
        const parsed = EventEnvelopeSchema.parse(envelope);
        expect(parsed).toEqual(envelope);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trips the cursor codec for any keyset pair', () => {
    fc.assert(
      fc.property(cursorPairArb, (pair) => {
        const decoded = decodeCdcCursor(encodeCdcCursor(pair));
        expect(decoded).toEqual(pair);
      }),
      { numRuns: 100 },
    );
  });

  it('never throws on malformed cursor tokens — returns null', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const decoded = decodeCdcCursor(raw);
        // decode được thì phải encode ngược lại đúng token gốc (canonical),
        // còn lại phải là null — không bao giờ ném exception.
        if (decoded !== null) {
          expect(encodeCdcCursor(decoded)).toBe(raw);
        } else {
          expect(decoded).toBeNull();
        }
      }),
      { numRuns: 200 },
    );
  });

  it('rejects an envelope whose type disagrees with operation', () => {
    const valid = EventEnvelopeSchema.parse({
      id: 'evt1',
      type: 'items.update',
      schemaVersion: 1,
      siteId: 's1',
      collection: 'posts',
      itemId: 'itm1',
      operation: 'update',
      occurredAt: new Date(0).toISOString(),
      actor: { type: 'system' },
      source: 'system',
      cursor: encodeCdcCursor({ occurredAtMs: 0, eventId: 'evt1' }),
    });
    expect(valid.type).toBe('items.update');
    expect(() =>
      EventEnvelopeSchema.parse({ ...valid, type: 'items.destroy' }),
    ).toThrow();
  });
});

// ── Zod boundary tests (task 1.5) ───────────────────────────────────────

describe('cdc-feed Zod boundaries', () => {
  it('feed query: limit accepts [1, 500], rejects outside, defaults to 100', () => {
    expect(CdcFeedQuerySchema.parse({ limit: '1' }).limit).toBe(1);
    expect(CdcFeedQuerySchema.parse({ limit: '500' }).limit).toBe(500);
    expect(CdcFeedQuerySchema.parse({}).limit).toBe(100);
    expect(() => CdcFeedQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => CdcFeedQuerySchema.parse({ limit: '501' })).toThrow();
  });

  it('feed query: CSV collections/operations parse to arrays', () => {
    const q = CdcFeedQuerySchema.parse({ collections: 'posts,pages', operations: 'create,delete' });
    expect(q.collections).toEqual(['posts', 'pages']);
    expect(q.operations).toEqual(['create', 'delete']);
  });

  it('settings: retentionDays accepts [1, 90], defaults 7/off', () => {
    expect(CdcFeedSettingsSchema.parse({})).toEqual({ enabled: false, retentionDays: 7 });
    expect(CdcFeedSettingsSchema.parse({ retentionDays: 1 }).retentionDays).toBe(1);
    expect(CdcFeedSettingsSchema.parse({ retentionDays: 90 }).retentionDays).toBe(90);
    expect(() => CdcFeedSettingsSchema.parse({ retentionDays: 0 })).toThrow();
    expect(() => CdcFeedSettingsSchema.parse({ retentionDays: 91 })).toThrow();
  });

  it('subscription: name ≤ 128; webhook kind requires webhook_id; extension kind requires extension_name', () => {
    expect(() =>
      CdcSubscriptionCreateSchema.parse({ name: 'a'.repeat(129), kind: 'pull' }),
    ).toThrow();
    expect(
      CdcSubscriptionCreateSchema.parse({ name: 'a'.repeat(128), kind: 'pull' }).name,
    ).toHaveLength(128);
    expect(() =>
      CdcSubscriptionCreateSchema.parse({ name: 'hook', kind: 'webhook' }),
    ).toThrow(/webhook_id/);
    expect(() =>
      CdcSubscriptionCreateSchema.parse({ name: 'ext', kind: 'extension' }),
    ).toThrow(/extension_name/);
    expect(
      CdcSubscriptionCreateSchema.parse({ name: 'ok', kind: 'webhook', webhook_id: 'wh1' })
        .payload_mode,
    ).toBe('reference');
  });
});
