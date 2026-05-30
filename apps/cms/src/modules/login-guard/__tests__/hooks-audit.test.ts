import { describe, it, expect, vi } from 'vitest';
import { type Database } from '@lumibase/database';

import type { NotificationDeps } from '../hooks';
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
import type { AuditLogger, AuditLogWriteInput } from '../../audit/logger';

/**
 * Unit tests for the task 11.2 audit wiring threaded into the
 * LoginGuard hooks — `recordLoginFailure` (`login_failed`,
 * `user_locked`, `ip_blocked`), `recordLoginSuccess` (`login_success`,
 * `anomaly_triggered`), and `recordAnomalyBlock` (`anomaly_triggered`).
 *
 * A spy AuditLogger records every `write(entry)` so we can assert the
 * exact `event` code + masked metadata each path emits when a logger is
 * injected via the `notify.audit` bundle field. Backward-compat: when
 * no `audit` is supplied the hooks must NOT write (the existing
 * `hooks.test.ts` / `hooks-notifications.test.ts` suites exercise that
 * implicitly by never passing one).
 *
 * **Validates: Requirements 15.1, 15.2**
 */

// ── Fakes ──────────────────────────────────────────────────────────────

function makeSpyAudit(): { audit: AuditLogger; calls: AuditLogWriteInput[] } {
  const calls: AuditLogWriteInput[] = [];
  const audit = {
    async write(entry: AuditLogWriteInput) {
      calls.push(entry);
    },
  } as unknown as AuditLogger;
  return { audit, calls };
}

/**
 * Minimal fake DB mirroring `hooks-notifications.test.ts`: the fluent
 * `insert(...).values(...)` and `update(...).set(...).where(...)` calls
 * resolve without Postgres, and `transaction(cb)` hands the same query
 * API to the callback.
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

// ── recordLoginFailure → login_failed / user_locked / ip_blocked ───────

describe('recordLoginFailure → audit (Req 15.1)', () => {
  it('writes login_failed for every failed attempt with the reason in metadata', async () => {
    const { audit, calls } = makeSpyAudit();
    await recordLoginFailure(
      makeFakeDb(),
      makeCounter({ user: 1, ip: 1 }),
      freshPolicy(),
      {
        email: '  Admin@Example.COM ',
        ip: '203.0.113.7',
        reason: 'invalid_credentials',
        userAgent: 'curl/8.0',
        userId: 'usr_1',
      },
      FIXED_NOW,
      { audit, requestId: 'req_abc' },
    );

    const failed = calls.filter((c) => c.event === 'login_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      event: 'login_failed',
      actorEmail: 'admin@example.com',
      targetEmail: 'admin@example.com',
      ip: '203.0.113.7',
      userAgent: 'curl/8.0',
      requestId: 'req_abc',
      metadata: { reason: 'invalid_credentials' },
    });
  });

  it('writes user_locked (in addition to login_failed) when the user crosses the threshold', async () => {
    const { audit, calls } = makeSpyAudit();
    await recordLoginFailure(
      makeFakeDb(),
      makeCounter({ user: 5, ip: 0 }),
      freshPolicy({ userMaxFailedAttempts: 5 }),
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
      { audit, requestId: 'req_lock' },
    );

    const locked = calls.filter((c) => c.event === 'user_locked');
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({
      event: 'user_locked',
      actorEmail: null,
      targetEmail: 'a@b.com',
      requestId: 'req_lock',
    });
    expect(locked[0]!.metadata).toMatchObject({
      reason: 'invalid_credentials',
      userFailedCount: 5,
      userMaxFailedAttempts: 5,
    });
    // login_failed always fires too.
    expect(calls.filter((c) => c.event === 'login_failed')).toHaveLength(1);
  });

  it('writes ip_blocked when the IP crosses the threshold', async () => {
    const { audit, calls } = makeSpyAudit();
    await recordLoginFailure(
      makeFakeDb(),
      makeCounter({ user: 0, ip: 20 }),
      freshPolicy({ ipMaxFailedAttempts: 20 }),
      {
        email: 'victim@example.com',
        ip: '198.51.100.9',
        reason: 'invalid_credentials',
      },
      FIXED_NOW,
      { audit },
    );

    const blocked = calls.filter((c) => c.event === 'ip_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({
      event: 'ip_blocked',
      actorEmail: null,
      ip: '198.51.100.9',
    });
    expect(blocked[0]!.metadata).toMatchObject({
      triggeringEmail: 'victim@example.com',
      ipFailedCount: 20,
      threshold: 20,
    });
  });

  it('is a no-op when no audit logger is injected (backward compatibility)', async () => {
    // Legacy call shape with no notify bundle at all.
    const out = await recordLoginFailure(
      makeFakeDb(),
      makeCounter({ user: 5, ip: 25 }),
      freshPolicy({ userMaxFailedAttempts: 5 }),
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
    );
    expect(out.userLocked).toBe(true);
    expect(out.ipBlocked).toBe(true);
  });
});

// ── recordLoginSuccess → login_success / anomaly_triggered ─────────────

describe('recordLoginSuccess → audit (Req 15.1)', () => {
  it('writes login_success with the anomaly verdict in metadata', async () => {
    const { audit, calls } = makeSpyAudit();
    const updateBaseline = vi.fn().mockResolvedValue(undefined);
    await recordLoginSuccess(
      makeFakeDb(),
      {
        userId: 'usr_123',
        email: 'Foo@Example.com',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        attempt: { countryCode: 'US', geoLookupStatus: 'ok' },
        anomalyScore: 0,
      },
      { updateBaseline, now: FIXED_NOW, notify: { audit, requestId: 'req_ok' } },
    );

    const success = calls.filter((c) => c.event === 'login_success');
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({
      event: 'login_success',
      actorEmail: 'foo@example.com',
      targetEmail: 'foo@example.com',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      countryCode: 'US',
      requestId: 'req_ok',
    });
    // No anomaly_triggered on the normal path.
    expect(calls.filter((c) => c.event === 'anomaly_triggered')).toHaveLength(0);
  });

  it('also writes anomaly_triggered when anomalyTriggered=true (notify_only path)', async () => {
    const { audit, calls } = makeSpyAudit();
    const updateBaseline = vi.fn().mockResolvedValue(undefined);
    await recordLoginSuccess(
      makeFakeDb(),
      {
        userId: 'usr_123',
        email: 'foo@example.com',
        ip: '203.0.113.7',
        attempt: { countryCode: 'CN' },
        anomalyScore: 0.876,
        anomalyTriggered: true,
        baselineWarmup: false,
      },
      { updateBaseline, now: FIXED_NOW, notify: { audit } },
    );

    expect(calls.filter((c) => c.event === 'login_success')).toHaveLength(1);
    const triggered = calls.filter((c) => c.event === 'anomaly_triggered');
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.metadata).toMatchObject({
      anomalyScore: 0.88,
      action: 'notify_only',
    });
  });

  it('is a no-op when no audit logger is supplied (backward compatibility)', async () => {
    const updateBaseline = vi.fn().mockResolvedValue(undefined);
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

// ── recordAnomalyBlock → anomaly_triggered ─────────────────────────────

describe('recordAnomalyBlock → audit (Req 15.1)', () => {
  it('writes anomaly_triggered for action="lock" with the action/reason in metadata', async () => {
    const { audit, calls } = makeSpyAudit();
    await recordAnomalyBlock(
      makeFakeDb(),
      freshPolicy({ userLockoutDurationSeconds: 900 }),
      {
        userId: 'usr_123',
        email: 'Foo@Example.com',
        ip: '203.0.113.7',
        attempt: { countryCode: 'RU', geoLookupStatus: 'ok' },
        anomalyScore: 0.95,
        baselineWarmup: false,
        action: 'lock',
      },
      FIXED_NOW,
      { audit, requestId: 'req_anom' },
    );

    const triggered = calls.filter((c) => c.event === 'anomaly_triggered');
    expect(triggered).toHaveLength(1);
    expect(triggered[0]).toMatchObject({
      event: 'anomaly_triggered',
      actorEmail: 'foo@example.com',
      ip: '203.0.113.7',
      countryCode: 'RU',
      requestId: 'req_anom',
    });
    expect(triggered[0]!.metadata).toMatchObject({
      anomalyScore: 0.95,
      action: 'lock',
      reason: 'anomaly_lock',
    });
  });

  it('writes anomaly_triggered for action="require_mfa" too', async () => {
    const { audit, calls } = makeSpyAudit();
    await recordAnomalyBlock(
      makeFakeDb(),
      freshPolicy(),
      {
        userId: 'usr_123',
        email: 'foo@example.com',
        ip: '203.0.113.7',
        anomalyScore: 1,
        baselineWarmup: false,
        action: 'require_mfa',
      },
      FIXED_NOW,
      { audit },
    );

    const triggered = calls.filter((c) => c.event === 'anomaly_triggered');
    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.metadata).toMatchObject({
      action: 'require_mfa',
      reason: 'mfa_required',
    });
  });

  it('is a no-op when no audit logger is injected (backward compatibility)', async () => {
    await expect(
      recordAnomalyBlock(
        makeFakeDb(),
        freshPolicy(),
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

// ── best-effort: a throwing audit logger never breaks the hook ─────────

describe('best-effort audit (never fails the login)', () => {
  it('swallows an audit logger that throws/rejects', async () => {
    const throwingAudit = {
      async write() {
        throw new Error('audit DB exploded');
      },
    } as unknown as AuditLogger;
    const notify: NotificationDeps = { audit: throwingAudit };

    const out = await recordLoginFailure(
      makeFakeDb(),
      makeCounter({ user: 5, ip: 0 }),
      freshPolicy({ userMaxFailedAttempts: 5 }),
      { email: 'a@b.com', ip: '203.0.113.7', reason: 'invalid_credentials' },
      FIXED_NOW,
      notify,
    );
    // The lockout side effect still applied; the throw was contained.
    expect(out.userLocked).toBe(true);
  });
});
