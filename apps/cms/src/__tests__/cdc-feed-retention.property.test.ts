import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  InMemoryRetentionStore,
  pruneChangeFeed,
  type InMemoryRetentionSubscription,
  type StaleSubscriptionNotice,
} from '../modules/cdc/change-feed/retention';

/**
 * Feature: cdc-extension-integration, Property 10: Retention & stale
 *
 * For any retention window and cursor state: prune SHALL delete exactly the
 * events older than the cutoff; a subscription whose checkpoint predates the
 * cutoff SHALL flip to `stale` (with a notification) and never be silently
 * skipped; runs are idempotent (Req 6.1, 6.3, 6.4).
 */

const NOW_MS = 1_900_000_000_000;
const DAY = 86_400_000;

const retentionDaysArb = fc.integer({ min: 1, max: 90 });

const eventArb = fc
  .record({ ageDays: fc.double({ min: 0, max: 120, noNaN: true }) })
  .map(({ ageDays }, ) => ({
    siteId: 'site_A',
    occurredAt: new Date(NOW_MS - ageDays * DAY),
  }));

const subArb: fc.Arbitrary<Omit<InMemoryRetentionSubscription, 'id' | 'name'>> = fc.record({
  siteId: fc.constant('site_A'),
  status: fc.constantFrom<'active' | 'paused' | 'dead' | 'stale'>(
    'active',
    'paused',
    'dead',
    'stale',
  ),
  cursor: fc.option(
    fc
      .double({ min: 0, max: 120, noNaN: true })
      .map((ageDays) => ({ occurredAtMs: NOW_MS - ageDays * DAY, eventId: 'e' })),
    { nil: null },
  ),
});

describe('Feature: cdc-extension-integration, Property 10: Retention & stale', () => {
  it('prunes exactly the events past the cutoff and flips exactly the lagging subs to stale', async () => {
    await fc.assert(
      fc.asyncProperty(
        retentionDaysArb,
        fc.array(eventArb, { maxLength: 30 }),
        fc.array(subArb, { maxLength: 10 }),
        async (retentionDays, events, subSeeds) => {
          const cutoffMs = NOW_MS - retentionDays * DAY;
          const subs = subSeeds.map((s, i) => ({ ...s, id: `sub_${i}`, name: `s${i}` }));
          const store = new InMemoryRetentionStore(
            structuredClone(subs),
            events.map((e, i) => ({ ...e, id: `evt_${i}` })),
            [],
          );
          const notices: StaleSubscriptionNotice[] = [];
          const result = await pruneChangeFeed(
            {
              store,
              retentionDays,
              now: () => new Date(NOW_MS),
              notifyStale: (n) => {
                notices.push(n);
              },
            },
            'site_A',
          );

          // Events: chỉ còn lại đúng những event >= cutoff.
          const expectedKept = events.filter((e) => e.occurredAt.getTime() >= cutoffMs).length;
          expect(store.events).toHaveLength(expectedKept);
          expect(result.prunedEvents).toBe(events.length - expectedKept);
          expect(store.events.every((e) => e.occurredAt.getTime() >= cutoffMs)).toBe(true);

          // Subs: active/paused có cursor < cutoff → stale + notice; còn lại giữ nguyên.
          const expectedStale = subs.filter(
            (s) =>
              (s.status === 'active' || s.status === 'paused') &&
              s.cursor !== null &&
              s.cursor.occurredAtMs < cutoffMs,
          );
          expect(new Set(result.staleSubscriptions)).toEqual(
            new Set(expectedStale.map((s) => s.id)),
          );
          expect(notices).toHaveLength(expectedStale.length);
          for (const s of expectedStale) {
            expect(store.subs.find((x) => x.id === s.id)!.status).toBe('stale');
          }
          // dead/stale/null-cursor không bao giờ bị đụng.
          for (const s of subs) {
            if (!expectedStale.some((x) => x.id === s.id)) {
              expect(store.subs.find((x) => x.id === s.id)!.status).toBe(s.status);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('is idempotent: a second run at the same instant prunes nothing and notifies nobody', async () => {
    await fc.assert(
      fc.asyncProperty(
        retentionDaysArb,
        fc.array(eventArb, { maxLength: 20 }),
        fc.array(subArb, { maxLength: 8 }),
        async (retentionDays, events, subSeeds) => {
          const subs = subSeeds.map((s, i) => ({ ...s, id: `sub_${i}`, name: `s${i}` }));
          const store = new InMemoryRetentionStore(
            structuredClone(subs),
            events.map((e, i) => ({ ...e, id: `evt_${i}` })),
          );
          const deps = { store, retentionDays, now: () => new Date(NOW_MS) };
          await pruneChangeFeed(deps, 'site_A');
          const second = await pruneChangeFeed(deps, 'site_A');
          expect(second.prunedEvents).toBe(0);
          expect(second.staleSubscriptions).toHaveLength(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('never touches another site', async () => {
    const store = new InMemoryRetentionStore(
      [{ id: 'b1', name: 'b', siteId: 'site_B', status: 'active', cursor: { occurredAtMs: 0, eventId: 'e' } }],
      [{ id: 'eb', siteId: 'site_B', occurredAt: new Date(0) }],
    );
    const result = await pruneChangeFeed(
      { store, retentionDays: 1, now: () => new Date(NOW_MS) },
      'site_A',
    );
    expect(result.prunedEvents).toBe(0);
    expect(store.events).toHaveLength(1);
    expect(store.subs[0]!.status).toBe('active');
  });
});
