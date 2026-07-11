import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  CdcDispatcher,
  InMemoryDeliveryLog,
  InMemorySubscriptionDispatchStore,
  retryDelayMs,
  DEAD_FAILURE_THRESHOLD,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
  type DispatchableSubscription,
  type DeadSubscriptionNotice,
  type EnvelopeSender,
} from '../modules/cdc/change-feed/dispatcher';
import {
  InMemoryCdcEventStore,
  type StoredChangeEvent,
} from '../modules/cdc/change-feed/feed-reader';
import {
  signCdcWebhookBody,
  verifyCdcWebhookSignature,
  mergeWebhookHeaders,
  SIGNATURE_HEADER,
} from '../modules/cdc/change-feed/webhook-sender';

/**
 * Feature: cdc-extension-integration, Property 5: HMAC verify round-trip
 *
 * For any secret/body/timestamp, the produced signature SHALL verify with
 * that secret and SHALL fail with any other secret or a tampered body
 * (Req 4.2).
 *
 * Feature: cdc-extension-integration, Property 6: Cursor advance có điều kiện
 *
 * For any delivery outcome sequence, the checkpoint SHALL advance exactly
 * past successfully delivered batches and never past a failed one — no event
 * is ever skipped (Req 4.4).
 *
 * Feature: cdc-extension-integration, Property 7: Retry/backoff đúng lịch
 *
 * A failing batch SHALL be attempted exactly MAX_DELIVERY_ATTEMPTS times with
 * 30s·2^n spacing, and DEAD_FAILURE_THRESHOLD exhausted batches SHALL flip
 * the subscription to dead with exactly one notification (Req 4.5).
 */

const NOW_MS = 1_900_000_000_000;

let seq = 0;
function makeEvent(occurredAtMs: number): StoredChangeEvent {
  seq += 1;
  return {
    id: `evt_${String(seq).padStart(6, '0')}`,
    siteId: 'site_A',
    collection: 'posts',
    itemId: `itm_${seq}`,
    operation: 'update',
    payload: { title: 't' },
    changedFields: ['title'],
    schemaVersion: 1,
    actorType: 'user',
    actorId: 'u1',
    source: 'api',
    occurredAt: new Date(occurredAtMs),
  };
}

function makeSub(overrides: Partial<DispatchableSubscription> = {}): DispatchableSubscription {
  return {
    id: 'sub1',
    siteId: 'site_A',
    name: 'hook',
    kind: 'webhook',
    collections: [],
    operations: [],
    payloadMode: 'reference',
    cursor: null,
    consecutiveFailures: 0,
    webhookId: 'wh1',
    extensionName: null,
    ...overrides,
  };
}

function harness(opts: {
  events: StoredChangeEvent[];
  outcomes: boolean[]; // per ATTEMPT: shift()ed; empty → success
  sub?: Partial<DispatchableSubscription>;
  batchSize?: number;
}) {
  const eventStore = new InMemoryCdcEventStore([...opts.events]);
  const subs = new InMemorySubscriptionDispatchStore([makeSub(opts.sub)]);
  const log = new InMemoryDeliveryLog();
  const notices: DeadSubscriptionNotice[] = [];
  const attempts: boolean[] = [];
  const sender: EnvelopeSender = {
    deliver: async () => {
      const ok = opts.outcomes.length > 0 ? opts.outcomes.shift()! : true;
      attempts.push(ok);
      return { ok, httpStatus: ok ? 200 : 500, errorMessage: ok ? null : 'boom' };
    },
  };
  const sleeps: number[] = [];
  const dispatcher = new CdcDispatcher({
    eventStore,
    subscriptions: subs,
    deliveryLog: log,
    senders: { webhook: sender },
    notifyDead: (n) => {
      notices.push(n);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date(NOW_MS),
    batchSize: opts.batchSize ?? 2,
  });
  return { dispatcher, subs, log, notices, sleeps, attempts };
}

// ── Property 5 ──────────────────────────────────────────────────────────

describe('Feature: cdc-extension-integration, Property 5: HMAC verify round-trip', () => {
  const secretArb = fc.string({ minLength: 1, maxLength: 64 });
  const bodyArb = fc.string({ maxLength: 200 });
  const tsArb = fc.integer({ min: 0, max: 4_102_444_800 });

  it('a signature verifies with its secret and body', async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, bodyArb, tsArb, async (secret, body, ts) => {
        const header = await signCdcWebhookBody(secret, ts, body);
        expect(
          await verifyCdcWebhookSignature(secret, header, body, { toleranceSeconds: 0 }),
        ).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('verification fails with a different secret or tampered body', async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, secretArb, bodyArb, tsArb, async (s1, s2, body, ts) => {
        fc.pre(s1 !== s2);
        const header = await signCdcWebhookBody(s1, ts, body);
        expect(
          await verifyCdcWebhookSignature(s2, header, body, { toleranceSeconds: 0 }),
        ).toBe(false);
        expect(
          await verifyCdcWebhookSignature(s1, header, body + 'x', { toleranceSeconds: 0 }),
        ).toBe(false);
      }),
      { numRuns: 60 },
    );
  });

  it('rejects malformed headers and stale timestamps', async () => {
    expect(await verifyCdcWebhookSignature('s', 'garbage', 'b')).toBe(false);
    const header = await signCdcWebhookBody('s', 1_000, 'b');
    expect(
      await verifyCdcWebhookSignature('s', header, 'b', {
        nowSeconds: 1_000 + 301,
        toleranceSeconds: 300,
      }),
    ).toBe(false);
  });

  it('configured headers can never override the signature header (Req 4.2)', () => {
    const merged = mergeWebhookHeaders(
      { 'X-Lumibase-Signature': 'forged', 'x-lumibase-signature': 'forged2', A: 'b' },
      't=1,v1=real',
    );
    expect(merged[SIGNATURE_HEADER]).toBe('t=1,v1=real');
    expect(merged.A).toBe('b');
  });
});

// ── Property 6 ──────────────────────────────────────────────────────────

describe('Feature: cdc-extension-integration, Property 6: Cursor advance có điều kiện', () => {
  it('the cursor lands exactly after the last successful batch, never past a failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }), // số batch thành công trước khi fail
        fc.integer({ min: 1, max: 4 }), // batch size
        async (okBatches, batchSize) => {
          seq = 0;
          const total = (okBatches + 1) * batchSize; // đủ event cho okBatches + 1 batch fail
          const events = Array.from({ length: total }, (_, i) =>
            makeEvent(NOW_MS - 60_000 + i * 10),
          );
          // outcomes: mỗi batch ok 1 attempt; batch cuối fail cả MAX attempts
          const outcomes = [
            ...Array.from({ length: okBatches }, () => true),
            ...Array.from({ length: MAX_DELIVERY_ATTEMPTS }, () => false),
          ];
          const h = harness({ events, outcomes, batchSize });
          await h.dispatcher.dispatchSubscription(makeSub());

          const sub = h.subs.subs[0]!;
          if (okBatches === 0) {
            expect(sub.cursor).toBeNull(); // chưa từng advance
          } else {
            const lastDelivered = events[okBatches * batchSize - 1]!;
            expect(sub.cursor).toEqual({
              occurredAtMs: lastDelivered.occurredAt.getTime(),
              eventId: lastDelivered.id,
            });
          }
          // batch fail không advance → không event nào bị skip
          expect(sub.consecutiveFailures).toBe(1);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('a fully-successful lane drains every batch and resets failures', async () => {
    seq = 0;
    const events = Array.from({ length: 7 }, (_, i) => makeEvent(NOW_MS - 60_000 + i * 10));
    const h = harness({ events, outcomes: [], sub: { consecutiveFailures: 3 }, batchSize: 3 });
    await h.dispatcher.dispatchSubscription(makeSub({ consecutiveFailures: 3 }));
    const sub = h.subs.subs[0]!;
    expect(sub.cursor?.eventId).toBe(events[events.length - 1]!.id);
    expect(sub.consecutiveFailures).toBe(0);
    // 3 batches (3+3+1), mỗi batch 1 attempt success
    expect(h.log.entries.filter((e) => e.status === 'success')).toHaveLength(3);
  });
});

// ── Property 7 ──────────────────────────────────────────────────────────

describe('Feature: cdc-extension-integration, Property 7: Retry/backoff đúng lịch', () => {
  it('retryDelayMs follows 30s·2^n', () => {
    expect(retryDelayMs(2)).toBe(RETRY_BASE_DELAY_MS);
    expect(retryDelayMs(3)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(retryDelayMs(4)).toBe(RETRY_BASE_DELAY_MS * 4);
    expect(retryDelayMs(5)).toBe(RETRY_BASE_DELAY_MS * 8);
  });

  it('a failing batch is attempted exactly MAX times with the exact backoff spacing', async () => {
    seq = 0;
    const events = [makeEvent(NOW_MS - 60_000)];
    const h = harness({
      events,
      outcomes: Array.from({ length: MAX_DELIVERY_ATTEMPTS }, () => false),
      batchSize: 5,
    });
    await h.dispatcher.dispatchSubscription(makeSub());
    expect(h.attempts).toHaveLength(MAX_DELIVERY_ATTEMPTS);
    expect(h.sleeps).toEqual([
      RETRY_BASE_DELAY_MS,
      RETRY_BASE_DELAY_MS * 2,
      RETRY_BASE_DELAY_MS * 4,
      RETRY_BASE_DELAY_MS * 8,
    ]);
    // delivery log ghi đủ attempt 1..5, tất cả failed
    expect(h.log.entries.map((e) => e.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(h.log.entries.every((e) => e.status === 'failed')).toBe(true);
  });

  it('DEAD_FAILURE_THRESHOLD exhausted batches flip to dead with exactly one notice', async () => {
    seq = 0;
    const events = [makeEvent(NOW_MS - 60_000)];
    const eventStore = new InMemoryCdcEventStore(events);
    const subs = new InMemorySubscriptionDispatchStore([
      makeSub({ consecutiveFailures: DEAD_FAILURE_THRESHOLD - 1 }),
    ]);
    const log = new InMemoryDeliveryLog();
    const notices: DeadSubscriptionNotice[] = [];
    const dispatcher = new CdcDispatcher({
      eventStore,
      subscriptions: subs,
      deliveryLog: log,
      senders: {
        webhook: {
          deliver: async () => ({ ok: false, httpStatus: 503, errorMessage: 'down' }),
        },
      },
      notifyDead: (n) => {
        notices.push(n);
      },
      sleep: async () => {},
      now: () => new Date(NOW_MS),
    });
    await dispatcher.dispatchSubscription(subs.subs[0]!);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.consecutiveFailures).toBe(DEAD_FAILURE_THRESHOLD);
    expect(subs.dead).toEqual(['sub1']);
  });
});
