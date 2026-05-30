import { describe, it, expect, vi } from 'vitest';
import { type Database } from '@lumibase/database';

import type {
  NotificationDeps,
} from '../hooks';
import {
  recordAnomalyBlock,
  recordLoginFailure,
  recordLoginSuccess,
} from '../hooks';
import {
  STANDARD_LOCKOUT_POLICY,
  type LockoutPolicy,
} from '../../setup/policy-codec';
import type { CounterStore } from '../counter';
import type { NotificationDispatcher } from '../../notifications/dispatcher';
import type {
  NotificationChannel,
  NotificationPayload,
  SecurityEvent,
} from '../../notifications/types';

/**
 * Unit tests for the task 9.5 notification wiring threaded into the
 * LoginGuard hooks — `recordLoginFailure` (`user_locked`,
 * `ip_blocked`), `recordLoginSuccess` (`anomaly_triggered`), and
 * `recordAnomalyBlock` (`anomaly_lock`; NOT `require_mfa`).
 *
 * The tests assert the exact `NotificationPayload` + channels each of
 * the four Req 13.1 events dispatches when a dispatcher is injected,
 * and that no dispatch happens for the `require_mfa` anomaly-block
 * path. A spy dispatcher records every `(event, channels, payload)`
 * triple so we can match on it without spinning up the real queue /
 * channels.
 *
 * Backward-compat: when no `notify` bundle is supplied (or the
 * dispatcher / channels are absent) the hooks must not dispatch — the
 * existing `hooks.test.ts` suite exercises that path implicitly by
 * never passing a dispatcher.
 *
 * **Validates: Requirements 13.1**
 */

// ── Fakes ──────────────────────────────────────────────────────────────

interface DispatchCall {
  event: SecurityEvent;
  channels: readonly NotificationChannel[];
  payload: NotificationPayload;
}

function makeSpyDispatcher(): {
  dispatcher: NotificationDispatcher;
  calls: DispatchCall[];
} {
  const calls: DispatchCall[] = [];
  const dispatcher: NotificationDispatcher = {
    async dispatch(event, channels, payload) {
      calls.push({ event, channels, payload });
    },
  };
  return { dispatcher, calls };
}

/**
 * Minimal fake DB mirroring the recorder in `hooks.test.ts`: the
 * fluent `insert(...).values(...)` and `update(...).set(...).where(...)`
 * calls resolve without a live Postgres, and `transaction(cb)` hands
 * the same query API to the callback.
 */
function makeFakeDb(): Database {
  const queryApi = {
    insert() {
      return {
        async values() {
          /* no-op */
        },
      };
    },
    update() {
      const chain = {
        set() {
          return this;
        },
        async where() {
          /* no-op */
        },
      };
      return chain;
    },
  } as Record<string, unknown>;

  return {
    ...queryApi,
    async transaction(cb: (tx: Database) => Promise<unknown>) {
      return cb(queryApi as unknown as Database);
    },
  } as unknown as Database;
}

function makeCounter(opts: { user?: number; ip?: number }): CounterStore {
  return {
    async userFailedCount() {
      return opts.user ?? 0;
    },
    async ipFailedCount() {
      return opts.ip ?? 0;
    },
  };
}

function freshPolicy(overrides?: Partial<LockoutPolicy>): LockoutPolicy {
  return {
    ...STANDARD_LOCKOUT_POLICY,
    notifyChannels: [...STANDARD_LOCKOUT_POLICY.notifyChannels],
    ...overrides,
  };
}

const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z');

// ── user_locked (recordLoginFailure) ───────────────────────────────────

describe('recordLoginFailure → user_locked dispatch (Req 13.1)', () => {
  it('dispatches user_locked with the policy channels + correct payload when the user crosses the threshold', async () => {
    const { dispatcher, calls } = makeSpyDispatcher();
    const counter = makeCounter({ user: 5, ip: 0 });
    const policy = freshPolicy({
      userMaxFailedAttempts: 5,
      userLockoutDurationSeconds: 900,
      notifyChannels: ['email', 'webhook'],
    });

    await recordLoginFailure(
      makeFakeDb(),
      counter,
      policy,
      {
        email: '  Admin@Example.COM ',
        ip: '203.0.113.7',
        reason: 'invalid_credentials',
        userAgent: 'curl/8.0',
        userId: 'usr_1',
      },
      FIXED_NOW,
      { dispatcher, notifyChannels: policy.notifyChannels },
    );

    const locked = calls.filter((c) => c.event === 'user_locked');
    expect(locked).toHaveLength(1);
    expect(locked[0]!.channels).toEqual(['email', 'webhook']);
    expect(locked[0]!.payload).toEqual({
      event: 'user_locked',
      timestamp: FIXED_NOW.toISOString(),
      email: 'admin@example.com',
      ip: '203.0.113.7',
      country: null,
      userAgent: 'curl/8.0',
      anomalyScore: null,
      action: 'locked',
    });
  });

  it('does NOT dispatch user_locked when below the threshold', async () => {
    const { dispatcher, calls } = makeSpyDispatcher();
    const counter = makeCounter({ user: 4, ip: 0 });
    const policy = freshPolicy({ userMaxFailedAttempts: 5 });

    await recordLoginFailure(
      makeFakeDb(),
      counter,
      policy,
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
      { dispatcher, notifyChannels: policy.notifyChannels },
    );

    expect(calls.filter((c) => c.event === 'user_locked')).toHaveLength(0);
  });

  it('is a no-op when no dispatcher is injected (backward compatibility)', async () => {
    const counter = makeCounter({ user: 5, ip: 25 });
    const policy = freshPolicy({ userMaxFailedAttempts: 5 });
    // No `notify` arg at all — the legacy call shape. Should not throw
    // and should still apply the lockout outcome.
    const out = await recordLoginFailure(
      makeFakeDb(),
      counter,
      policy,
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
    );
    expect(out.userLocked).toBe(true);
    expect(out.ipBlocked).toBe(true);
  });
});

// ── ip_blocked (recordLoginFailure) ────────────────────────────────────

describe('recordLoginFailure → ip_blocked dispatch (Req 13.1)', () => {
  it('dispatches ip_blocked with action="blocked" + triggering email when the IP crosses the threshold', async () => {
    const { dispatcher, calls } = makeSpyDispatcher();
    const counter = makeCounter({ user: 0, ip: 20 });
    const policy = freshPolicy({
      ipMaxFailedAttempts: 20,
      notifyChannels: ['email'],
    });

    await recordLoginFailure(
      makeFakeDb(),
      counter,
      policy,
      {
        email: 'victim@example.com',
        ip: '198.51.100.9',
        reason: 'invalid_credentials',
        userAgent: 'bot/1.0',
      },
      FIXED_NOW,
      { dispatcher, notifyChannels: policy.notifyChannels },
    );

    const blocked = calls.filter((c) => c.event === 'ip_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.channels).toEqual(['email']);
    expect(blocked[0]!.payload).toEqual({
      event: 'ip_blocked',
      timestamp: FIXED_NOW.toISOString(),
      email: 'victim@example.com',
      ip: '198.51.100.9',
      country: null,
      userAgent: 'bot/1.0',
      anomalyScore: null,
      action: 'blocked',
    });
  });

  it('does NOT dispatch ip_blocked below the threshold', async () => {
    const { dispatcher, calls } = makeSpyDispatcher();
    const counter = makeCounter({ user: 0, ip: 5 });
    const policy = freshPolicy({ ipMaxFailedAttempts: 20 });

    await recordLoginFailure(
      makeFakeDb(),
      counter,
      policy,
      { email: 'a@b.com', ip: '198.51.100.9', reason: 'invalid_credentials' },
      FIXED_NOW,
      { dispatcher, notifyChannels: policy.notifyChannels },
    );

    expect(calls.filter((c) => c.event === 'ip_blocked')).toHaveLength(0);
  });
});

// ── anomaly_triggered (recordLoginSuccess) ─────────────────────────────

describe('recordLoginSuccess → anomaly_triggered dispatch (Req 13.1)', () => {
  it('dispatches anomaly_triggered with action="allowed" + score + country when anomalyTriggered=true', async () => {
    const { dispatcher, calls } = makeSpyDispatcher();
    const updateBaseline = vi.fn().mockResolvedValue(undefined);
    const channels: NotificationChannel[] = ['email', 'webhook'];
    const notify: NotificationDeps = { dispatcher, notifyChannels: channels };

    await recordLoginSuccess(
      makeFakeDb(),
      {
        userId: 'usr_123',
        email: 'Foo@Example.com',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        attempt: { countryCode: 'CN', geoLookupStatus: 'ok' },
        anomalyScore: 1,
        anomalyTriggered: true,
        baselineWarmup: false,
      },
      { updateBaseline, now: FIXED_NOW, notify },
    );

    const triggered = calls.filter((c) => c.event === 'anomaly_triggered');
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.channels).toEqual(channels);
    expect(triggered[0]!.payload).toEqual({
      event: 'anomaly_triggered',
      timestamp: FIXED_NOW.toISOString(),
      email: 'foo@example.com',
      ip: '203.0.113.7',
      country: 'CN',
      userAgent: 'Mozilla/5.0',
      anomalyScore: 1,
      action: 'allowed',
    });
  });

  it('does NOT dispatch when anomalyTriggered is false/omitted (the normal login)', async () => {
    const { dispatcher, calls } = makeSpyDispatcher();
    const updateBaseline = vi.fn().mockResolvedValue(undefined);

    await recordLoginSuccess(
      makeFakeDb(),
      {
        userId: 'usr_123',
        email: 'foo@example.com',
        ip: '203.0.113.7',
        anomalyScore: 0,
      },
      {
        updateBaseline,
        now: FIXED_NOW,
        notify: { dispatcher, notifyChannels: ['email'] },
      },
    );

    expect(calls).toHaveLength(0);
  });

  it('rounds the anomaly score to 2 decimals on the payload', async () => {
    const { dispatcher, calls } = makeSpyDispatcher();
    const updateBaseline = vi.fn().mockResolvedValue(undefined);

    await recordLoginSuccess(
      makeFakeDb(),
      {
        userId: 'usr_123',
        email: 'foo@example.com',
        ip: '203.0.113.7',
        attempt: { countryCode: null },
        anomalyScore: 0.876,
        anomalyTriggered: true,
        baselineWarmup: false,
      },
      {
        updateBaseline,
        now: FIXED_NOW,
        notify: { dispatcher, notifyChannels: ['email'] },
      },
    );

    expect(calls[0]!.payload.anomalyScore).toBe(0.88);
  });

  it('is a no-op when no notify bundle is supplied (backward compatibility)', async () => {
    const updateBaseline = vi.fn().mockResolvedValue(undefined);
    // Legacy two-arg + options-without-notify shape used by existing
    // tests must still work even with anomalyTriggered set.
    await expect(
      recordLoginSuccess(
        makeFakeDb(),
        {
          userId: 'usr_123',
          email: 'foo@example.com',
          ip: '203.0.113.7',
          anomalyScore: 1,
          anomalyTriggered: true,
          baselineWarmup: false,
        },
        { updateBaseline, now: FIXED_NOW },
      ),
    ).resolves.toBeUndefined();
  });
});

// ── anomaly_lock (recordAnomalyBlock) ──────────────────────────────────

describe('recordAnomalyBlock → anomaly_lock dispatch (Req 13.1)', () => {
  it('dispatches anomaly_lock with action="locked" + score + country for action="lock"', async () => {
    const { dispatcher, calls } = makeSpyDispatcher();
    const policy = freshPolicy({
      userLockoutDurationSeconds: 900,
      notifyChannels: ['webhook'],
    });

    await recordAnomalyBlock(
      makeFakeDb(),
      policy,
      {
        userId: 'usr_123',
        email: 'Foo@Example.com',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        attempt: { countryCode: 'RU', geoLookupStatus: 'ok' },
        anomalyScore: 0.95,
        baselineWarmup: false,
        action: 'lock',
      },
      FIXED_NOW,
      { dispatcher, notifyChannels: policy.notifyChannels },
    );

    const locked = calls.filter((c) => c.event === 'anomaly_lock');
    expect(locked).toHaveLength(1);
    expect(locked[0]!.channels).toEqual(['webhook']);
    expect(locked[0]!.payload).toEqual({
      event: 'anomaly_lock',
      timestamp: FIXED_NOW.toISOString(),
      email: 'foo@example.com',
      ip: '203.0.113.7',
      country: 'RU',
      userAgent: 'Mozilla/5.0',
      anomalyScore: 0.95,
      action: 'locked',
    });
  });

  it('does NOT dispatch any notification for action="require_mfa" (not in Req 13.1 set)', async () => {
    const { dispatcher, calls } = makeSpyDispatcher();
    const policy = freshPolicy({ notifyChannels: ['email', 'webhook'] });

    await recordAnomalyBlock(
      makeFakeDb(),
      policy,
      {
        userId: 'usr_123',
        email: 'foo@example.com',
        ip: '203.0.113.7',
        attempt: { countryCode: 'RU' },
        anomalyScore: 0.95,
        baselineWarmup: false,
        action: 'require_mfa',
      },
      FIXED_NOW,
      { dispatcher, notifyChannels: policy.notifyChannels },
    );

    expect(calls).toHaveLength(0);
  });

  it('is a no-op when no dispatcher is injected (backward compatibility)', async () => {
    const policy = freshPolicy();
    await expect(
      recordAnomalyBlock(
        makeFakeDb(),
        policy,
        {
          userId: 'usr_123',
          email: 'foo@example.com',
          ip: '203.0.113.7',
          anomalyScore: 1,
          baselineWarmup: false,
          action: 'lock',
        },
        FIXED_NOW,
      ),
    ).resolves.toBeUndefined();
  });
});

// ── best-effort: dispatch errors never break the hook ──────────────────

describe('best-effort dispatch (Req 13.4 — never fails the login)', () => {
  it('swallows a dispatcher that throws/rejects', async () => {
    const throwingDispatcher: NotificationDispatcher = {
      async dispatch() {
        throw new Error('queue exploded');
      },
    };
    const counter = makeCounter({ user: 5, ip: 0 });
    const policy = freshPolicy({ userMaxFailedAttempts: 5 });

    const out = await recordLoginFailure(
      makeFakeDb(),
      counter,
      policy,
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
      { dispatcher: throwingDispatcher, notifyChannels: policy.notifyChannels },
    );
    // The lockout side effect still applied; the throw was contained.
    expect(out.userLocked).toBe(true);
  });

  it('skips dispatch entirely when the channel list is empty', async () => {
    const { dispatcher, calls } = makeSpyDispatcher();
    const counter = makeCounter({ user: 5, ip: 0 });
    const policy = freshPolicy({
      userMaxFailedAttempts: 5,
      notifyChannels: [],
    });

    await recordLoginFailure(
      makeFakeDb(),
      counter,
      policy,
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
      { dispatcher, notifyChannels: policy.notifyChannels },
    );

    expect(calls).toHaveLength(0);
  });
});
