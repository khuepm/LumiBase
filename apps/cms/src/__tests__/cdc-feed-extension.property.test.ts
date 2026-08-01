import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ExtensionEnvelopeSender,
  filterEnvelopesByCapability,
  parseCdcSubscribeCapabilities,
  type CdcSubscriberLoader,
} from '../modules/cdc/change-feed/extension-sender';
import {
  CdcDispatcher,
  InMemoryDeliveryLog,
  InMemorySubscriptionDispatchStore,
  buildEnvelope,
  type DispatchableSubscription,
} from '../modules/cdc/change-feed/dispatcher';
import {
  InMemoryCdcEventStore,
  type StoredChangeEvent,
} from '../modules/cdc/change-feed/feed-reader';
import type { CdcEventEnvelope } from '@lumibase/contracts';

/**
 * Feature: cdc-extension-integration, Property 12: Subscriber isolation
 *
 * For any set of extension subscribers where some handlers throw or hang,
 * every other subscription still receives its full event stream — one
 * subscription is one lane (Req 5.4). Plus host-side capability enforcement
 * (Req 5.2): events outside the granted `cdc:subscribe:<collection>`
 * capabilities never reach a handler.
 */

const NOW_MS = 1_900_000_000_000;
let seq = 0;
function makeEvent(collection: string): StoredChangeEvent {
  seq += 1;
  return {
    id: `evt_${String(seq).padStart(5, '0')}`,
    siteId: 'site_A',
    collection,
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

function extSub(id: string, extensionName: string): DispatchableSubscription {
  return {
    id,
    siteId: 'site_A',
    name: `ext:${extensionName}`,
    kind: 'extension',
    collections: [],
    operations: [],
    payloadMode: 'reference',
    cursor: null,
    consecutiveFailures: 0,
    webhookId: null,
    extensionName,
  };
}

describe('cdc:subscribe capability parsing (Req 5.2)', () => {
  it('derives exactly the granted collections; * wins; none → null', () => {
    expect(parseCdcSubscribeCapabilities([])).toBeNull();
    expect(parseCdcSubscribeCapabilities(['items:read:posts'])).toBeNull();
    expect(parseCdcSubscribeCapabilities(['cdc:subscribe:posts'])).toEqual(new Set(['posts']));
    expect(
      parseCdcSubscribeCapabilities(['cdc:subscribe:posts', 'cdc:subscribe:pages']),
    ).toEqual(new Set(['posts', 'pages']));
    expect(parseCdcSubscribeCapabilities(['cdc:subscribe:*'])).toBe('*');
  });

  it('host filter never leaks an uncovered collection (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('posts', 'pages', 'products'), { maxLength: 20 }),
        fc.subarray(['posts', 'pages', 'products']),
        (eventCollections, granted) => {
          const envelopes = eventCollections.map(
            (collection, i) =>
              ({ collection, id: `e${i}` }) as unknown as CdcEventEnvelope,
          );
          const allowed = new Set(granted);
          const visible = filterEnvelopesByCapability(envelopes, allowed);
          expect(visible.every((e) => allowed.has(e.collection))).toBe(true);
          expect(visible).toHaveLength(
            envelopes.filter((e) => allowed.has(e.collection)).length,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Feature: cdc-extension-integration, Property 12: Subscriber isolation', () => {
  it('a throwing/hanging subscriber never starves the others', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 15 }),
        fc.constantFrom<'throw' | 'hang'>('throw', 'hang'),
        async (eventCount, failureMode) => {
          seq = 0;
          const events = Array.from({ length: eventCount }, () => makeEvent('posts'));
          const received: string[] = [];
          const loader: CdcSubscriberLoader = {
            load: async (_siteId, name) => ({
              allowedCollections: '*',
              config: {},
              handler:
                name === 'bad'
                  ? failureMode === 'throw'
                    ? () => {
                        throw new Error('subscriber exploded');
                      }
                    : () => new Promise<void>(() => {}) // never resolves
                  : ({ events: batch }) => {
                      received.push(...batch.map((e) => e.id));
                    },
            }),
          };
          const store = new InMemoryCdcEventStore([...events]);
          const subs = new InMemorySubscriptionDispatchStore([
            extSub('sub_bad', 'bad'),
            extSub('sub_good', 'good'),
          ]);
          const dispatcher = new CdcDispatcher({
            eventStore: store,
            subscriptions: subs,
            deliveryLog: new InMemoryDeliveryLog(),
            senders: {
              extension: new ExtensionEnvelopeSender({ loader, timeoutMs: 20 }),
            },
            sleep: async () => {},
            now: () => new Date(NOW_MS),
            maxAttempts: 2,
          });
          await dispatcher.dispatchSite('site_A');

          // Subscriber tốt nhận đủ toàn bộ event, đúng thứ tự.
          expect(received).toEqual(events.map((e) => e.id));
          const good = subs.subs.find((s) => s.id === 'sub_good')!;
          expect(good.cursor?.eventId).toBe(events[events.length - 1]!.id);
          // Subscriber hỏng không advance và bị đếm failure.
          const bad = subs.subs.find((s) => s.id === 'sub_bad')!;
          expect(bad.cursor).toBeNull();
          expect(bad.consecutiveFailures).toBe(1);
        },
      ),
      { numRuns: 25 },
    );
  });

  it('an extension without cdc capability is blocked entirely (Req 5.2)', async () => {
    seq = 0;
    const events = [makeEvent('posts')];
    const loader: CdcSubscriberLoader = { load: async () => null }; // capability missing
    const sender = new ExtensionEnvelopeSender({ loader });
    const outcome = await sender.deliver(extSub('s1', 'no-cap'), [
      buildEnvelope(events[0]!, 'reference'),
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.errorMessage).toContain('lacks cdc:subscribe');
  });

  it('events fully outside the capability advance the cursor without invoking the handler', async () => {
    seq = 0;
    let handlerCalls = 0;
    const loader: CdcSubscriberLoader = {
      load: async () => ({
        allowedCollections: new Set(['pages']),
        config: {},
        handler: () => {
          handlerCalls += 1;
        },
      }),
    };
    const sender = new ExtensionEnvelopeSender({ loader });
    const outcome = await sender.deliver(extSub('s1', 'scoped'), [
      buildEnvelope(makeEvent('posts'), 'reference'),
    ]);
    expect(outcome.ok).toBe(true); // batch coi như xong — cursor được advance, không kẹt
    expect(handlerCalls).toBe(0);
  });
});
