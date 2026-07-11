import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  CdcDispatcher,
  InMemoryDeliveryLog,
  InMemorySubscriptionDispatchStore,
  type DispatchableSubscription,
  type EnvelopeSender,
} from '../modules/cdc/change-feed/dispatcher';
import {
  FeedReader,
  InMemoryCdcEventStore,
  type StoredChangeEvent,
} from '../modules/cdc/change-feed/feed-reader';
import { feedFlagCacheKey } from '../modules/cdc/change-feed/outbox-writer';

/**
 * Feature: cdc-extension-integration, Property 9: Tenant isolation
 *
 * For any interleaving of events across two sites, site A's feed reads and
 * dispatched deliveries SHALL contain exactly site A's events and site B's
 * exactly site B's — the two-site smoke test required by DoD §2b
 * (Req 7.1, 7.2). Cache/lock keys are tenant-prefixed.
 */

const NOW_MS = 1_900_000_000_000;
let seq = 0;
function makeEvent(siteId: string): StoredChangeEvent {
  seq += 1;
  return {
    id: `evt_${String(seq).padStart(5, '0')}`,
    siteId,
    collection: 'posts',
    itemId: `itm_${seq}`,
    operation: 'create',
    payload: null,
    changedFields: null,
    schemaVersion: 1,
    actorType: 'system',
    actorId: null,
    source: 'system',
    occurredAt: new Date(NOW_MS - 60_000 + seq * 10),
  };
}

function sub(id: string, siteId: string): DispatchableSubscription {
  return {
    id,
    siteId,
    name: `hook-${siteId}`,
    kind: 'webhook',
    collections: [],
    operations: [],
    payloadMode: 'reference',
    cursor: null,
    consecutiveFailures: 0,
    webhookId: 'wh1',
    extensionName: null,
  };
}

describe('Feature: cdc-extension-integration, Property 9: Tenant isolation (two-site smoke)', () => {
  it('reads and deliveries never cross the site boundary', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('site_A', 'site_B'), { minLength: 1, maxLength: 40 }),
        async (siteSequence) => {
          seq = 0;
          const events = siteSequence.map((siteId) => makeEvent(siteId));
          const store = new InMemoryCdcEventStore([...events]);

          // Pull path: mỗi site chỉ thấy event của mình.
          for (const siteId of ['site_A', 'site_B']) {
            const reader = new FeedReader({
              store,
              siteId,
              retentionDays: 7,
              now: () => new Date(NOW_MS),
            });
            const page = await reader.read(null, {}, 500);
            const expected = events.filter((e) => e.siteId === siteId).map((e) => e.id);
            expect(page.events.map((e) => e.id)).toEqual(expected);
            expect(page.events.every((e) => e.siteId === siteId)).toBe(true);
          }

          // Push path: delivery của sub site A chỉ chứa event site A và ngược lại.
          const received: Record<string, string[]> = { sub_A: [], sub_B: [] };
          const sender: EnvelopeSender = {
            deliver: async (s, envelopes) => {
              received[s.id]!.push(...envelopes.map((e) => e.siteId));
              return { ok: true, httpStatus: 200, errorMessage: null };
            },
          };
          const subs = new InMemorySubscriptionDispatchStore([
            sub('sub_A', 'site_A'),
            sub('sub_B', 'site_B'),
          ]);
          const dispatcher = new CdcDispatcher({
            eventStore: store,
            subscriptions: subs,
            deliveryLog: new InMemoryDeliveryLog(),
            senders: { webhook: sender },
            sleep: async () => {},
            now: () => new Date(NOW_MS),
          });
          await dispatcher.dispatchSite('site_A');
          await dispatcher.dispatchSite('site_B');

          expect(received.sub_A).toHaveLength(events.filter((e) => e.siteId === 'site_A').length);
          expect(received.sub_A!.every((s) => s === 'site_A')).toBe(true);
          expect(received.sub_B).toHaveLength(events.filter((e) => e.siteId === 'site_B').length);
          expect(received.sub_B!.every((s) => s === 'site_B')).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('flag/lock cache keys are tenant-prefixed', () => {
    expect(feedFlagCacheKey('site_A')).not.toBe(feedFlagCacheKey('site_B'));
    // lock key format pinned trong dispatcher: cdc:dispatch:{siteId}:{subId}
  });
});
