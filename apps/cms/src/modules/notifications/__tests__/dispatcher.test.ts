import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createNotificationDispatcher,
  defaultNotificationAuditWriter,
  InProcessNotificationDispatcher,
  DRAIN_MAX_WALLCLOCK_MS,
  MAX_ATTEMPTS,
  RATE_LIMIT_TTL_MS,
  TICK_INTERVAL_MS,
  type NotificationAuditEntry,
} from '../dispatcher';
import type {
  DeliveryResult,
  NotificationChannel,
  NotificationChannelAdapter,
  NotificationPayload,
  SecurityEvent,
} from '../types';

/**
 * Feature: admin-setup-wizard, task 9.4 — notification dispatcher
 * in-process retry queue + per-(event,email) rate-limiter.
 *
 * Coverage:
 *
 *   1. Success dispatch — a single tick delivers to every configured
 *      channel and the queue drains (Req 13.1).
 *   2. Multi-channel fan-out — one dispatch produces one independent
 *      task per channel; channels retry on their own schedule
 *      (design §9.4).
 *   3. Retryable failure → exponential backoff (1s/2s) → eventual
 *      drop after MAX_ATTEMPTS → audit `notification_delivery_failed`
 *      (Req 13.4, design §9.4).
 *   4. Non-retryable failure → immediate drop, no backoff slots
 *      consumed → audit `notification_delivery_failed` (Req 13.4).
 *   5. Rate-limit hit within 60s → drop + audit
 *      `notification_rate_limited` (explicit, not silent) (Req 13.5).
 *   6. Rate-limit expiry after 60s → re-dispatch allowed; stale key
 *      lazily evicted (design §9.5).
 *   7. 250ms tick mechanism — start()/stop() drive processTick via
 *      fake timers (design §9.4).
 *
 * The dispatcher is driven deterministically via an injected clock
 * (`now`) and the public `processTick(now)` method so the backoff
 * schedule is verified without waiting real seconds. Where the timer
 * itself is under test we use `vi.useFakeTimers()`.
 *
 * **Validates: Requirements 13.4, 13.5**
 */

// ── Fixtures ──────────────────────────────────────────────────────────

const basePayload: NotificationPayload = {
  event: 'user_locked',
  timestamp: '2025-01-15T10:20:30.000Z',
  email: 'admin@example.com',
  ip: '203.0.113.5',
  country: 'US',
  userAgent: 'Mozilla/5.0',
  anomalyScore: null,
  action: 'locked',
};

/**
 * Controllable clock: tests advance `value` explicitly and pass the
 * same accessor to the dispatcher so `dispatch`, `processTick`, and
 * the rate-limit window all read one coherent time source.
 */
function makeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    set: (v: number) => {
      value = v;
    },
    advance: (delta: number) => {
      value += delta;
    },
  };
}

/**
 * Scriptable channel adapter. `script` is a queue of results returned
 * in order on successive `send()` calls; once exhausted the last
 * entry repeats. Records every payload it was asked to send.
 */
class FakeChannel implements NotificationChannelAdapter {
  readonly sent: NotificationPayload[] = [];
  private readonly script: DeliveryResult[];

  constructor(
    readonly name: NotificationChannel,
    script: DeliveryResult[] = [{ ok: true }],
  ) {
    this.script = script;
  }

  send(payload: NotificationPayload): Promise<DeliveryResult> {
    this.sent.push(payload);
    const idx = Math.min(this.sent.length - 1, this.script.length - 1);
    return Promise.resolve(this.script[idx]!);
  }

  get callCount(): number {
    return this.sent.length;
  }
}

const OK: DeliveryResult = { ok: true };
const RETRYABLE: DeliveryResult = {
  ok: false,
  error: 'webhook-503',
  retryable: true,
};
const PERMANENT: DeliveryResult = {
  ok: false,
  error: 'webhook-401',
  retryable: false,
};

function auditSink() {
  const entries: NotificationAuditEntry[] = [];
  const writer = (entry: NotificationAuditEntry) => {
    entries.push(entry);
  };
  return { entries, writer };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Tunables ──────────────────────────────────────────────────────────

describe('dispatcher tunables', () => {
  it('pins the design §9.4 / Req 13.5 constants', () => {
    expect(TICK_INTERVAL_MS).toBe(250);
    expect(MAX_ATTEMPTS).toBe(3);
    expect(RATE_LIMIT_TTL_MS).toBe(60_000);
    // Drain budget sits comfortably under the ~30s Worker ceiling.
    expect(DRAIN_MAX_WALLCLOCK_MS).toBe(25_000);
    expect(DRAIN_MAX_WALLCLOCK_MS).toBeLessThan(30_000);
  });
});

// ── 1. Success dispatch ───────────────────────────────────────────────

describe('dispatch — success path', () => {
  it('delivers to a single channel and drains the queue on one tick', async () => {
    const clock = makeClock(1_000);
    const email = new FakeChannel('email', [OK]);
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [email],
      audit: writer,
      now: clock.now,
    });

    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    expect(dispatcher.pendingCount).toBe(1);

    await dispatcher.processTick(clock.now());

    expect(email.callCount).toBe(1);
    expect(email.sent[0]).toBe(basePayload);
    expect(dispatcher.pendingCount).toBe(0);
    // No failures, no rate-limit suppression.
    expect(entries).toEqual([]);
  });

  it('is a no-op for channels with no registered adapter', async () => {
    const clock = makeClock(1_000);
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [],
      audit: writer,
      now: clock.now,
    });

    // 'email' isn't registered → nothing scheduled, no audit.
    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    expect(dispatcher.pendingCount).toBe(0);
    expect(entries).toEqual([]);
  });
});

// ── 2. Multi-channel fan-out ──────────────────────────────────────────

describe('dispatch — multi-channel fan-out', () => {
  it('produces one independent task per channel', async () => {
    const clock = makeClock(1_000);
    const email = new FakeChannel('email', [OK]);
    const webhook = new FakeChannel('webhook', [OK]);
    const dispatcher = createNotificationDispatcher({
      channels: [email, webhook],
      now: clock.now,
    });

    await dispatcher.dispatch(
      'anomaly_triggered',
      ['email', 'webhook'],
      basePayload,
    );
    expect(dispatcher.pendingCount).toBe(2);

    await dispatcher.processTick(clock.now());

    expect(email.callCount).toBe(1);
    expect(webhook.callCount).toBe(1);
    expect(dispatcher.pendingCount).toBe(0);
  });

  it('retries a flaky channel independently of a healthy one', async () => {
    const clock = makeClock(1_000);
    // email succeeds immediately; webhook fails once (retryable) then
    // succeeds — they must not block one another.
    const email = new FakeChannel('email', [OK]);
    const webhook = new FakeChannel('webhook', [RETRYABLE, OK]);
    const dispatcher = createNotificationDispatcher({
      channels: [email, webhook],
      now: clock.now,
    });

    await dispatcher.dispatch(
      'anomaly_triggered',
      ['email', 'webhook'],
      basePayload,
    );

    // Tick 1: email delivered + removed; webhook fails, reschedules +1s.
    await dispatcher.processTick(clock.now());
    expect(email.callCount).toBe(1);
    expect(webhook.callCount).toBe(1);
    expect(dispatcher.pendingCount).toBe(1);

    // A tick before the backoff elapses must NOT retry the webhook.
    clock.advance(999);
    await dispatcher.processTick(clock.now());
    expect(webhook.callCount).toBe(1);
    expect(dispatcher.pendingCount).toBe(1);

    // Once the 1s backoff elapses, the webhook retries and succeeds.
    clock.advance(1);
    await dispatcher.processTick(clock.now());
    expect(webhook.callCount).toBe(2);
    expect(dispatcher.pendingCount).toBe(0);
  });
});

// ── 3. Retryable failure → backoff → drop ─────────────────────────────

describe('processTick — retryable failure backoff + drop (Req 13.4)', () => {
  it('retries on the 1s/2s schedule and drops after MAX_ATTEMPTS with an audit', async () => {
    const clock = makeClock(10_000);
    // Always retryable → exhaust the attempt budget.
    const webhook = new FakeChannel('webhook', [RETRYABLE]);
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [webhook],
      audit: writer,
      now: clock.now,
    });

    await dispatcher.dispatch('user_locked', ['webhook'], basePayload);

    // Attempt 1 (t=10_000): fail, schedule +1s (2**0).
    await dispatcher.processTick(clock.now());
    expect(webhook.callCount).toBe(1);
    expect(dispatcher.pendingCount).toBe(1);
    expect(entries).toEqual([]);

    // Before +1s: no retry.
    clock.advance(999);
    await dispatcher.processTick(clock.now());
    expect(webhook.callCount).toBe(1);

    // At +1s: attempt 2, fail, schedule +2s (2**1).
    clock.advance(1);
    await dispatcher.processTick(clock.now());
    expect(webhook.callCount).toBe(2);
    expect(dispatcher.pendingCount).toBe(1);
    expect(entries).toEqual([]);

    // Before +2s: no retry.
    clock.advance(1_999);
    await dispatcher.processTick(clock.now());
    expect(webhook.callCount).toBe(2);

    // At +2s: attempt 3 → reaches MAX_ATTEMPTS → drop + audit.
    clock.advance(1);
    await dispatcher.processTick(clock.now());
    expect(webhook.callCount).toBe(3);
    expect(dispatcher.pendingCount).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      event: 'notification_delivery_failed',
      securityEvent: 'user_locked',
      email: 'admin@example.com',
      channel: 'webhook',
      error: 'webhook-503',
    });
  });

  it('delivers successfully on a retry before the cap and writes no failure audit', async () => {
    const clock = makeClock(0);
    const webhook = new FakeChannel('webhook', [RETRYABLE, RETRYABLE, OK]);
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [webhook],
      audit: writer,
      now: clock.now,
    });

    await dispatcher.dispatch('ip_blocked', ['webhook'], basePayload);

    await dispatcher.processTick(clock.now()); // attempt 1: fail → +1s
    clock.advance(1_000);
    await dispatcher.processTick(clock.now()); // attempt 2: fail → +2s
    clock.advance(2_000);
    await dispatcher.processTick(clock.now()); // attempt 3: OK

    expect(webhook.callCount).toBe(3);
    expect(dispatcher.pendingCount).toBe(0);
    expect(entries).toEqual([]);
  });
});

// ── 4. Non-retryable failure → immediate drop ─────────────────────────

describe('processTick — non-retryable failure (Req 13.4)', () => {
  it('drops immediately on the first attempt and audits the failure', async () => {
    const clock = makeClock(5_000);
    const email = new FakeChannel('email', [PERMANENT]);
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [email],
      audit: writer,
      now: clock.now,
    });

    await dispatcher.dispatch('anomaly_lock', ['email'], basePayload);
    await dispatcher.processTick(clock.now());

    // Sent exactly once — no backoff slots consumed.
    expect(email.callCount).toBe(1);
    expect(dispatcher.pendingCount).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      event: 'notification_delivery_failed',
      securityEvent: 'anomaly_lock',
      email: 'admin@example.com',
      channel: 'email',
      error: 'webhook-401',
    });

    // A later tick must not re-send a dropped task.
    clock.advance(10_000);
    await dispatcher.processTick(clock.now());
    expect(email.callCount).toBe(1);
  });

  it('normalises an adapter that throws into a retryable failure', async () => {
    const clock = makeClock(0);
    const throwing: NotificationChannelAdapter = {
      name: 'webhook',
      send: () => Promise.reject(new Error('boom')),
    };
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [throwing],
      audit: writer,
      now: clock.now,
    });

    await dispatcher.dispatch('user_locked', ['webhook'], basePayload);

    // A thrown error is treated as retryable: attempt 1 fails, task
    // stays queued with a backoff rather than dropping immediately.
    await dispatcher.processTick(clock.now());
    expect(dispatcher.pendingCount).toBe(1);
    expect(entries).toEqual([]);

    // Walk it out to the cap to confirm it eventually drops + audits.
    clock.advance(1_000);
    await dispatcher.processTick(clock.now());
    clock.advance(2_000);
    await dispatcher.processTick(clock.now());
    expect(dispatcher.pendingCount).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toBe('notification_delivery_failed');
    expect(entries[0]!.error).toBe('boom');
  });
});

// ── 5. Rate-limit hit within 60s (Req 13.5) ───────────────────────────

describe('dispatch — rate-limit (Req 13.5)', () => {
  it('drops a second dispatch for the same (event,email) within 60s and audits it', async () => {
    const clock = makeClock(100_000);
    const email = new FakeChannel('email', [OK]);
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [email],
      audit: writer,
      now: clock.now,
    });

    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    expect(dispatcher.pendingCount).toBe(1);

    // 30s later — still within the 60s window → suppressed.
    clock.advance(30_000);
    await dispatcher.dispatch('user_locked', ['email'], basePayload);

    // No new task enqueued; one rate-limit audit written (explicit).
    expect(dispatcher.pendingCount).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      event: 'notification_rate_limited',
      securityEvent: 'user_locked',
      email: 'admin@example.com',
    });
  });

  it('keys the window on (event, email): a different event is not suppressed', async () => {
    const clock = makeClock(0);
    const email = new FakeChannel('email', [OK]);
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [email],
      audit: writer,
      now: clock.now,
    });

    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    // Same email, different event → distinct key → allowed.
    await dispatcher.dispatch('anomaly_triggered', ['email'], {
      ...basePayload,
      event: 'anomaly_triggered',
    });

    expect(dispatcher.pendingCount).toBe(2);
    expect(entries).toEqual([]);
  });

  it('keys the window on email case-insensitively', async () => {
    const clock = makeClock(0);
    const email = new FakeChannel('email', [OK]);
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [email],
      audit: writer,
      now: clock.now,
    });

    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    // Upper-cased + padded email collapses to the same key → suppressed.
    await dispatcher.dispatch('user_locked', ['email'], {
      ...basePayload,
      email: '  ADMIN@EXAMPLE.COM  ',
    });

    expect(dispatcher.pendingCount).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toBe('notification_rate_limited');
  });
});

// ── 6. Rate-limit expiry after 60s (design §9.5) ──────────────────────

describe('dispatch — rate-limit expiry + lazy eviction (design §9.5)', () => {
  it('allows a re-dispatch once the 60s window has elapsed', async () => {
    const clock = makeClock(0);
    const email = new FakeChannel('email', [OK, OK]);
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [email],
      audit: writer,
      now: clock.now,
    });

    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    await dispatcher.processTick(clock.now());
    expect(email.callCount).toBe(1);

    // Exactly 60s later the window has elapsed (>= TTL) → allowed.
    clock.advance(RATE_LIMIT_TTL_MS);
    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    await dispatcher.processTick(clock.now());

    expect(email.callCount).toBe(2);
    // Neither dispatch was suppressed.
    expect(entries).toEqual([]);
  });

  it('boundary: a dispatch one ms before the TTL is still suppressed', async () => {
    const clock = makeClock(0);
    const email = new FakeChannel('email', [OK]);
    const { entries, writer } = auditSink();
    const dispatcher = createNotificationDispatcher({
      channels: [email],
      audit: writer,
      now: clock.now,
    });

    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    clock.advance(RATE_LIMIT_TTL_MS - 1);
    await dispatcher.dispatch('user_locked', ['email'], basePayload);

    expect(dispatcher.pendingCount).toBe(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toBe('notification_rate_limited');
  });
});

// ── 7. drain — Workers waitUntil path (task 9.6, Req 13.4) ────────────

describe('drain — bounded queue drain for Workers (task 9.6)', () => {
  /**
   * drain() walks the queue itself (no setInterval), honouring the
   * 1s/2s backoff by *actually waiting* between ticks. We drive it
   * with vi fake timers so the real `setTimeout`-backed sleep helper
   * resolves deterministically, while the dispatcher clock is the
   * faked system time so backoff scheduling and the sleep agree.
   *
   * **Validates: Requirements 13.4** (delivery best-effort; design §9.4)
   */

  it('drains a ready queue to completion without waiting', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const email = new FakeChannel('email', [OK]);
    const webhook = new FakeChannel('webhook', [OK]);
    const dispatcher = new InProcessNotificationDispatcher({
      channels: [email, webhook],
    });

    await dispatcher.dispatch(
      'anomaly_triggered',
      ['email', 'webhook'],
      basePayload,
    );
    expect(dispatcher.pendingCount).toBe(2);

    // Both tasks are due immediately → drain ticks once and empties.
    const done = dispatcher.drain();
    await vi.runAllTimersAsync();
    await done;

    expect(email.callCount).toBe(1);
    expect(webhook.callCount).toBe(1);
    expect(dispatcher.pendingCount).toBe(0);
  });

  it('sleeps out the 1s/2s backoff then drains a flaky task to success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Fails twice (retryable) then succeeds on the third attempt.
    const webhook = new FakeChannel('webhook', [RETRYABLE, RETRYABLE, OK]);
    const { entries, writer } = auditSink();
    const dispatcher = new InProcessNotificationDispatcher({
      channels: [webhook],
      audit: writer,
    });

    await dispatcher.dispatch('user_locked', ['webhook'], basePayload);

    const done = dispatcher.drain();
    // Walk all scheduled sleeps (1s then 2s) to completion.
    await vi.runAllTimersAsync();
    await done;

    // Three sends: t=0 (fail), t=1s (fail), t=3s (ok).
    expect(webhook.callCount).toBe(3);
    expect(dispatcher.pendingCount).toBe(0);
    // Delivered before the cap → no failure audit.
    expect(entries).toEqual([]);
  });

  it('drains a permanently-flaky task to the MAX_ATTEMPTS drop + audit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const webhook = new FakeChannel('webhook', [RETRYABLE]);
    const { entries, writer } = auditSink();
    const dispatcher = new InProcessNotificationDispatcher({
      channels: [webhook],
      audit: writer,
    });

    await dispatcher.dispatch('ip_blocked', ['webhook'], basePayload);

    const done = dispatcher.drain();
    await vi.runAllTimersAsync();
    await done;

    expect(webhook.callCount).toBe(MAX_ATTEMPTS);
    expect(dispatcher.pendingCount).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      event: 'notification_delivery_failed',
      securityEvent: 'ip_blocked',
      email: 'admin@example.com',
      channel: 'webhook',
      error: 'webhook-503',
    });
  });

  it('returns immediately when the queue is empty', async () => {
    const clock = makeClock(0);
    const dispatcher = createNotificationDispatcher({ now: clock.now });
    // Nothing queued — must resolve without scheduling any timer.
    await expect(dispatcher.drain()).resolves.toBeUndefined();
  });

  it('stops draining once the wall-clock budget is exhausted (leaves the rest queued)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Always retryable → without a budget this would loop ~3s per
    // task; the tiny budget forces an early bail with work still
    // queued (the accepted Workers limitation, design §9.4).
    const webhook = new FakeChannel('webhook', [RETRYABLE]);
    const dispatcher = new InProcessNotificationDispatcher({
      channels: [webhook],
    });

    await dispatcher.dispatch('user_locked', ['webhook'], basePayload);

    // Budget shorter than the first 1s backoff: one tick fires
    // (t=0), the task reschedules to t=1s, then the drain sees the
    // soonest attempt is past the deadline and bails.
    const done = dispatcher.drain({ maxWallclockMs: 500 });
    await vi.runAllTimersAsync();
    await done;

    // Sent once, then left queued — budget stopped further retries.
    expect(webhook.callCount).toBe(1);
    expect(dispatcher.pendingCount).toBe(1);
  });

  it('never throws even if the audit writer throws (detached in waitUntil)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const email = new FakeChannel('email', [PERMANENT]);
    const dispatcher = new InProcessNotificationDispatcher({
      channels: [email],
      audit: () => {
        throw new Error('audit-sink-down');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await dispatcher.dispatch('anomaly_lock', ['email'], basePayload);

    const done = dispatcher.drain();
    await vi.runAllTimersAsync();
    // A throwing audit sink must not reject the drain promise.
    await expect(done).resolves.toBeUndefined();
    expect(dispatcher.pendingCount).toBe(0);
  });
});

// ── 8. 250ms tick mechanism (design §9.4) ─────────────────────────────

describe('start/stop — 250ms background tick', () => {
  it('drains queued tasks on the timer cadence and stops cleanly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const email = new FakeChannel('email', [OK]);
    // Use the real Date.now-backed clock so the timer and the queue
    // share the faked system time.
    const dispatcher = new InProcessNotificationDispatcher({
      channels: [email],
    });

    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    expect(dispatcher.pendingCount).toBe(1);

    dispatcher.start();
    // Advance one tick interval; the interval callback fires and
    // processTick drains the ready task.
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);

    expect(email.callCount).toBe(1);
    expect(dispatcher.pendingCount).toBe(0);

    dispatcher.stop();
    // After stop, further time passing must not tick.
    await dispatcher.dispatch('ip_blocked', ['email'], {
      ...basePayload,
      event: 'ip_blocked',
    });
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS * 4);
    // The task enqueued after stop() is never sent.
    expect(email.callCount).toBe(1);
    expect(dispatcher.pendingCount).toBe(1);
  });

  it('start() is idempotent', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const email = new FakeChannel('email', [OK]);
    const dispatcher = new InProcessNotificationDispatcher({
      channels: [email],
    });

    dispatcher.start();
    dispatcher.start(); // second call is a no-op (no double interval)

    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    await vi.advanceTimersByTimeAsync(TICK_INTERVAL_MS);

    // Exactly one delivery despite two start() calls.
    expect(email.callCount).toBe(1);
    dispatcher.stop();
  });
});

// ── registerChannel + default audit writer ────────────────────────────

describe('registerChannel', () => {
  it('allows adding an adapter after construction', async () => {
    const clock = makeClock(0);
    const dispatcher = createNotificationDispatcher({ now: clock.now });
    const webhook = new FakeChannel('webhook', [OK]);

    // Before registration → no-op.
    await dispatcher.dispatch('user_locked', ['webhook'], basePayload);
    expect(dispatcher.pendingCount).toBe(0);

    dispatcher.registerChannel(webhook);
    // Different event so the rate-limit window doesn't suppress.
    await dispatcher.dispatch('ip_blocked', ['webhook'], {
      ...basePayload,
      event: 'ip_blocked',
    });
    await dispatcher.processTick(clock.now());
    expect(webhook.callCount).toBe(1);
  });
});

describe('defaultNotificationAuditWriter', () => {
  it('routes delivery failures to console.warn and rate-limits to console.info', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    defaultNotificationAuditWriter({
      event: 'notification_delivery_failed',
      securityEvent: 'user_locked' as SecurityEvent,
      email: 'admin@example.com',
      channel: 'email',
      error: 'webhook-401',
    });
    defaultNotificationAuditWriter({
      event: 'notification_rate_limited',
      securityEvent: 'user_locked' as SecurityEvent,
      email: 'admin@example.com',
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    // Collapses absent channel/error to null for a stable log shape.
    const infoArg = info.mock.calls[0]![1] as Record<string, unknown>;
    expect(infoArg.channel).toBeNull();
    expect(infoArg.error).toBeNull();
  });

  it('does not throw when used as the default sink end-to-end', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = makeClock(0);
    const email = new FakeChannel('email', [PERMANENT]);
    // No `audit` option → exercises defaultNotificationAuditWriter.
    const dispatcher = createNotificationDispatcher({
      channels: [email],
      now: clock.now,
    });

    await dispatcher.dispatch('user_locked', ['email'], basePayload);
    await expect(dispatcher.processTick(clock.now())).resolves.toBeUndefined();
    expect(dispatcher.pendingCount).toBe(0);
  });
});
