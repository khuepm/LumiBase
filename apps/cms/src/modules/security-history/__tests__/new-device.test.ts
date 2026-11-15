import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { MemoryRateLimiter } from '@lumibase/runtime';

import { fingerprint } from '../../anomaly/device';
import type { DeviceBaselineSnapshot, LoginAttemptDraft } from '../../anomaly/types';
import type { AuditLogWriteInput } from '../../audit/logger';
import {
  detectNewDevice,
  isNewDevice,
  NEW_DEVICE_EMAIL_LIMIT,
  notifyNewDeviceSignIn,
  type NewDeviceNoticeInput,
} from '../new-device';

/**
 * #739 — new-device sign-in: reuse of the anomaly device fingerprint +
 * baseline LRU, the "new" rule, and the rate-limited, never-throwing
 * notification that records a `new_device_login` audit event.
 */

const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36';

function baseline(fps: string[], successfulLogins = 5): DeviceBaselineSnapshot {
  return {
    successfulLogins,
    deviceFingerprints: fps.map((fp) => ({ fp, lastSeenAt: '2026-11-01T00:00:00.000Z' })),
  };
}

describe('isNewDevice', () => {
  it('is new only with history, a known device list, and an unknown fingerprint', () => {
    expect(isNewDevice(baseline(['aaa']), 'bbb')).toBe(true);
    expect(isNewDevice(baseline(['aaa', 'bbb']), 'bbb')).toBe(false);
    // First ever sign-in: nothing to compare against.
    expect(isNewDevice(null, 'bbb')).toBe(false);
    expect(isNewDevice(baseline(['aaa'], 0), 'bbb')).toBe(false);
    // Devices never recorded (device subscore was off before upgrading):
    // learn silently instead of mailing every user once.
    expect(isNewDevice(baseline([], 12), 'bbb')).toBe(false);
  });
});

describe('detectNewDevice', () => {
  const db = {} as Database;

  it('computes the anomaly fingerprint and stores it on the draft for the baseline', async () => {
    const attempt: LoginAttemptDraft = {};
    const known = await fingerprint(UA_MAC, 'en-US');
    const verdict = await detectNewDevice(db, 'u1', UA_ANDROID, 'en-US', attempt, {
      loadBaseline: async () => baseline([known]),
    });
    const expected = await fingerprint(UA_ANDROID, 'en-US');
    expect(verdict).toEqual({ isNew: true, fingerprint: expected });
    expect(attempt.deviceFingerprint).toBe(expected);
  });

  it('treats a browser update (version digits only) as the same device', async () => {
    const known = await fingerprint(UA_MAC, 'en-US');
    const updated = UA_MAC.replace('Chrome/130.0.0.0', 'Chrome/131.0.6778.86');
    const verdict = await detectNewDevice(db, 'u1', updated, 'en-US', {}, {
      loadBaseline: async () => baseline([known]),
    });
    expect(verdict.isNew).toBe(false);
  });

  it('reuses a fingerprint the device subscore already computed', async () => {
    const loadBaseline = vi.fn(async () => baseline(['other']));
    const verdict = await detectNewDevice(db, 'u1', UA_MAC, 'en', { deviceFingerprint: 'precomputed' }, { loadBaseline });
    expect(verdict).toEqual({ isNew: true, fingerprint: 'precomputed' });
  });

  it('never flags a request without a User-Agent', async () => {
    const loadBaseline = vi.fn(async () => baseline(['aaa']));
    const attempt: LoginAttemptDraft = {};
    expect(await detectNewDevice(db, 'u1', null, 'en', attempt, { loadBaseline })).toEqual({
      isNew: false,
      fingerprint: null,
    });
    expect(loadBaseline).not.toHaveBeenCalled();
    expect(attempt.deviceFingerprint).toBeUndefined();
  });

  it('fails closed to "not new" when the baseline read throws', async () => {
    const verdict = await detectNewDevice(db, 'u1', UA_MAC, 'en', {}, {
      loadBaseline: async () => {
        throw new Error('db down');
      },
    });
    expect(verdict.isNew).toBe(false);
  });
});

function noticeInput(over: Partial<NewDeviceNoticeInput> = {}) {
  const audits: AuditLogWriteInput[] = [];
  const send = vi.fn(async () => ({ attempted: true, ok: true }));
  const input: NewDeviceNoticeInput = {
    db: {} as Database,
    env: {} as NewDeviceNoticeInput['env'],
    rateLimiter: new MemoryRateLimiter(),
    siteId: 'site-a',
    userId: `u-${Math.random().toString(36).slice(2)}`,
    email: 'Me@Example.com',
    audience: 'studio',
    ip: '203.0.113.77',
    userAgent: UA_ANDROID,
    countryCode: 'VN',
    signedInAt: new Date('2026-11-14T10:00:00.000Z'),
    requestId: 'req-1',
    audit: { write: async (e) => void audits.push(e) },
    send,
    ...over,
  };
  return { input, audits, send };
}

describe('notifyNewDeviceSignIn', () => {
  it('emails the account owner with time, approximate IP and device, then audits it', async () => {
    const { input, audits, send } = noticeInput();
    expect(await notifyNewDeviceSignIn(input)).toEqual({ notified: true });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'Me@Example.com',
        siteId: 'site-a',
        audience: 'studio',
        ipApprox: '203.0.113.x',
        deviceLabel: 'Chrome on Android',
        countryCode: 'VN',
        signedInAt: input.signedInAt,
      }),
    );
    expect(audits).toEqual([
      expect.objectContaining({
        event: 'new_device_login',
        actorEmail: 'me@example.com',
        targetEmail: 'me@example.com',
        metadata: { userId: input.userId, deviceLabel: 'Chrome on Android', notified: true },
      }),
    ]);
  });

  it(`is rate-limited to ${NEW_DEVICE_EMAIL_LIMIT} emails per user per hour, still auditing the rest`, async () => {
    const limiter = new MemoryRateLimiter();
    const { input, audits, send } = noticeInput({ rateLimiter: limiter });
    const outcomes = [];
    for (let i = 0; i < NEW_DEVICE_EMAIL_LIMIT + 2; i++) outcomes.push(await notifyNewDeviceSignIn(input));
    expect(send).toHaveBeenCalledTimes(NEW_DEVICE_EMAIL_LIMIT);
    expect(outcomes.slice(NEW_DEVICE_EMAIL_LIMIT)).toEqual([
      { notified: false, reason: 'rate_limited' },
      { notified: false, reason: 'rate_limited' },
    ]);
    expect(audits).toHaveLength(NEW_DEVICE_EMAIL_LIMIT + 2);
    expect(audits.at(-1)?.metadata).toMatchObject({ notified: false, suppressedReason: 'rate_limited' });

    // Another user has their own budget.
    const other = noticeInput({ rateLimiter: limiter });
    expect(await notifyNewDeviceSignIn(other.input)).toEqual({ notified: true });
  });

  it('still rate-limits when the rate-limit backend is down (in-process fallback)', async () => {
    const broken = { consume: async () => { throw new Error('redis down'); } };
    const { input, send } = noticeInput({ rateLimiter: broken });
    for (let i = 0; i < NEW_DEVICE_EMAIL_LIMIT + 1; i++) await notifyNewDeviceSignIn(input);
    expect(send).toHaveBeenCalledTimes(NEW_DEVICE_EMAIL_LIMIT);
  });

  it('reports a missing mail transport without throwing', async () => {
    const { input, audits } = noticeInput({ send: async () => ({ attempted: false, ok: false, reason: 'email-not-configured' }) });
    expect(await notifyNewDeviceSignIn(input)).toEqual({ notified: false, reason: 'email_not_configured' });
    expect(audits[0]?.metadata).toMatchObject({ notified: false, suppressedReason: 'email_not_configured' });
  });

  it('never throws, even when the sender and the audit both throw', async () => {
    const { input } = noticeInput({
      send: async () => {
        throw new Error('smtp exploded');
      },
      audit: {
        write: async () => {
          throw new Error('audit exploded');
        },
      },
    });
    await expect(notifyNewDeviceSignIn(input)).resolves.toEqual({ notified: false, reason: 'error' });
  });
});
