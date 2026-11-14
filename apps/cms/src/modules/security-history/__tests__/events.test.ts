import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { approximateIp, describeUserAgent, SECURITY_HISTORY_KINDS } from '@lumibase/contracts';

import { HISTORY_EVENT_KINDS, HISTORY_EVENTS, toHistoryItem, type HistoryAuditRow } from '../events';

/**
 * #739 — redaction of audit rows into the caller's security history: only
 * allow-listed events, approximate IPs, no metadata beyond the per-kind
 * allow-list, and no IP/UA of another person who acted on the account.
 */

const ME = 'me@example.com';

function row(over: Partial<HistoryAuditRow> = {}): HistoryAuditRow {
  return {
    id: 'aud_1',
    timestamp: new Date('2026-11-14T10:00:00.000Z'),
    siteId: 'site-a',
    event: 'login_success',
    actorEmail: ME,
    targetEmail: ME,
    ip: '203.0.113.77',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0 Safari/537.36',
    countryCode: 'vn',
    metadata: {},
    ...over,
  };
}

describe('approximateIp', () => {
  it.each([
    ['203.0.113.77', '203.0.113.x'],
    ['::ffff:198.51.100.9', '198.51.100.x'],
    ['2001:db8:85a3:8d3:1319:8a2e:370:7348', '2001:db8:85a3::/48'],
    ['2001:DB8::1', '2001:db8::/48'],
    ['unknown', null],
    ['', null],
    ['999.1.1.1', null],
    ['not-an-ip', null],
    [null, null],
  ])('%s → %s', (input, expected) => {
    expect(approximateIp(input as string | null)).toBe(expected);
  });

  it('never returns the full IPv4 address (property)', () => {
    fc.assert(
      fc.property(fc.ipV4(), (ip) => {
        const out = approximateIp(ip);
        expect(out).not.toBe(ip);
        expect(out?.endsWith('.x')).toBe(true);
      }),
    );
  });
});

describe('describeUserAgent (shared with Studio)', () => {
  it('labels common browsers', () => {
    expect(describeUserAgent(row().userAgent).label).toBe('Chrome on macOS');
    expect(describeUserAgent(null).label).toBe('Unknown device');
  });
});

describe('allow-list', () => {
  it('maps every allowed audit code to a declared kind', () => {
    for (const kind of Object.values(HISTORY_EVENT_KINDS)) {
      expect(SECURITY_HISTORY_KINDS).toContain(kind);
    }
    expect(HISTORY_EVENTS).toContain('session_revoked');
    expect(HISTORY_EVENTS).toContain('new_device_login');
  });

  it.each(['setup_completed', 'ip_blocked', 'items_exported', 'admin_path_set', 'toString', '__proto__'])(
    'drops %s',
    (event) => {
      expect(toHistoryItem(row({ event }), ME)).toBeNull();
    },
  );
});

describe('toHistoryItem', () => {
  it('returns a redacted sign-in', () => {
    expect(toHistoryItem(row({ metadata: { method: 'totp', anomalyScore: 0.12 } }), ME)).toEqual({
      id: 'aud_1',
      kind: 'sign_in',
      occurredAt: '2026-11-14T10:00:00.000Z',
      siteId: 'site-a',
      ipApprox: '203.0.113.x',
      userAgent: row().userAgent,
      countryCode: 'VN',
      details: { method: 'totp' },
    });
  });

  it('drops the IP and UA of an administrator acting on the account', () => {
    const item = toHistoryItem(
      row({ event: 'user_unlocked', actorEmail: 'admin@example.com', metadata: { targetUserId: 'u1' } }),
      ME,
    );
    expect(item).toMatchObject({ kind: 'account_unlocked', ipApprox: null, userAgent: null, countryCode: null });
  });

  it('compares the actor case-insensitively', () => {
    const item = toHistoryItem(row({ event: 'password_changed', actorEmail: 'Me@Example.com' }), ME);
    expect(item?.ipApprox).toBe('203.0.113.x');
  });

  it('never copies session ids, request ids, emails or scores into details', () => {
    const item = toHistoryItem(
      row({
        event: 'session_revoked',
        metadata: { sessionId: 'fam-secret', current: true, userId: 'u1', siteId: 'site-a', email: ME },
      }),
      ME,
    );
    expect(item?.details).toEqual({ current: true });
  });

  it('keeps only known enum values', () => {
    expect(toHistoryItem(row({ event: 'login_failed', metadata: { reason: 'invalid_credentials' } }), ME)?.details)
      .toEqual({ reason: 'invalid_credentials' });
    expect(toHistoryItem(row({ event: 'login_failed', metadata: { reason: '<script>' } }), ME)?.details).toEqual({});
    expect(
      toHistoryItem(row({ event: 'sessions_revoked', metadata: { scope: 'others', revoked: 2 } }), ME)?.details,
    ).toEqual({ scope: 'others', revoked: 2 });
  });

  it('parses string metadata and tolerates garbage', () => {
    expect(
      toHistoryItem(row({ event: 'new_device_login', metadata: '{"deviceLabel":"Firefox on Linux","notified":true}' }), ME)
        ?.details,
    ).toEqual({ deviceLabel: 'Firefox on Linux', notified: true });
    expect(toHistoryItem(row({ metadata: '{nope' }), ME)?.details).toEqual({});
    expect(toHistoryItem(row({ metadata: null }), ME)?.details).toEqual({});
  });

  it('details are always a small allow-listed, primitive-only object (property)', () => {
    const allowedKeys = new Set([
      'method', 'reason', 'action', 'deviceLabel', 'notified', 'scope', 'revoked', 'current',
      'revokedOtherSessions', 'selfService',
    ]);
    fc.assert(
      fc.property(
        fc.constantFrom(...HISTORY_EVENTS),
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.option(fc.emailAddress(), { nil: null }),
        (event, metadata, actor) => {
          const item = toHistoryItem(row({ event, metadata, actorEmail: actor }), ME);
          expect(item).not.toBeNull();
          for (const [k, v] of Object.entries(item!.details)) {
            expect(allowedKeys.has(k)).toBe(true);
            expect(['string', 'number', 'boolean']).toContain(typeof v);
            if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(80);
          }
          if (item!.ipApprox !== null) expect(item!.ipApprox).not.toBe('203.0.113.77');
        },
      ),
    );
  });
});
