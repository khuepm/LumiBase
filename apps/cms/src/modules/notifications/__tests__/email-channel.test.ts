import { describe, it, expect, vi } from 'vitest';
import {
  buildEmailBody,
  buildEmailSubject,
  EMAIL_SUBJECT_PREFIX,
  EmailChannelFactory,
  SecurityEmailChannel,
} from '../email-channel';
import {
  MailchannelsTransport,
  NodemailerTransport,
} from '../../../services/email/transport';
import type { NotificationPayload } from '../types';

/**
 * Feature: admin-setup-wizard, task 9.2 — email notification channel.
 *
 * As of the email-service refactor the byte-pushing lives in
 * `services/email/transport.ts`; this channel now composes a transport and
 * owns only the spec-pinned subject/body templates + recipient-merge rule.
 *
 * Coverage:
 *
 *   1. Subject template — `[LumiBase Security] <event_code>` exact
 *      shape (Req 13.2).
 *   2. Body template — every variable from Req 13.2 appears, and
 *      optional `recoveryUrl` is appended only when supplied.
 *   3. Factory routing — Cloudflare runtime → MailChannels transport,
 *      Docker runtime → SMTP transport (or null when SMTP missing).
 *   4. Channel delivery results — DeliveryResult shape on success,
 *      failure, no recipients; recipient merge + dedupe.
 *
 * **Validates: Requirements 13.2 — see also design §9.2.**
 */

const samplePayload: NotificationPayload = {
  event: 'anomaly_triggered',
  timestamp: '2025-01-15T10:20:30.000Z',
  email: 'admin@example.com',
  ip: '203.0.113.5',
  country: 'US',
  userAgent: 'Mozilla/5.0',
  anomalyScore: 0.85,
  action: 'allowed',
};

// ── Subject ───────────────────────────────────────────────────────────

describe('buildEmailSubject', () => {
  it('uses the [LumiBase Security] <event_code> shape per Req 13.2', () => {
    expect(buildEmailSubject('anomaly_triggered')).toBe(
      '[LumiBase Security] anomaly_triggered',
    );
    expect(buildEmailSubject('user_locked')).toBe(
      '[LumiBase Security] user_locked',
    );
    expect(buildEmailSubject('ip_blocked')).toBe(
      '[LumiBase Security] ip_blocked',
    );
    expect(buildEmailSubject('anomaly_lock')).toBe(
      '[LumiBase Security] anomaly_lock',
    );
  });

  it('keeps EMAIL_SUBJECT_PREFIX as a stable literal', () => {
    expect(EMAIL_SUBJECT_PREFIX).toBe('[LumiBase Security]');
  });
});

// ── Body ──────────────────────────────────────────────────────────────

describe('buildEmailBody', () => {
  it('includes every Req 13.2 substitution variable on a populated payload', () => {
    const body = buildEmailBody(samplePayload);
    expect(body).toContain(samplePayload.timestamp);
    expect(body).toContain(samplePayload.email);
    expect(body).toContain(samplePayload.ip);
    expect(body).toContain('US');
    expect(body).toContain('Mozilla/5.0');
    expect(body).toContain('0.85');
    expect(body).toContain('anomaly_triggered');
    expect(body).toContain('allowed');
  });

  it('renders nullable fields as "unknown" / "n/a" rather than empty', () => {
    const body = buildEmailBody({
      ...samplePayload,
      country: null,
      userAgent: null,
      anomalyScore: null,
    });
    expect(body).toContain('Country:         unknown');
    expect(body).toContain('User-Agent:      unknown');
    expect(body).toContain('Anomaly score:   n/a');
  });

  it('appends the recovery link line only when supplied', () => {
    const without = buildEmailBody(samplePayload);
    expect(without).not.toContain('Recovery link:');

    const withUrl = buildEmailBody(samplePayload, {
      recoveryUrl: 'https://example.test/recovery',
    });
    expect(withUrl).toContain('Recovery link:   https://example.test/recovery');
  });

  it('does not embed any password-hash / token-like values from the payload', () => {
    // Defence-in-depth: the payload type structurally cannot carry
    // those fields, but the test pins the contract so a future
    // payload extension can't accidentally regress secret hygiene.
    const body = buildEmailBody(samplePayload);
    expect(body.toLowerCase()).not.toContain('passwordhash');
    expect(body.toLowerCase()).not.toContain('setup_token');
    expect(body.toLowerCase()).not.toContain('backup_code');
  });
});

// ── Factory routing ───────────────────────────────────────────────────

describe('EmailChannelFactory.fromEnv', () => {
  it('returns a MailChannels-backed channel on Cloudflare runtime', () => {
    const ch = EmailChannelFactory.fromEnv({
      LUMIBASE_ENV: 'production',
      LUMIBASE_RUNTIME: 'cloudflare',
    } as never);
    expect(ch).toBeInstanceOf(SecurityEmailChannel);
    expect(ch?.name).toBe('email');
  });

  it('returns an SMTP-backed channel on Docker runtime when SMTP URL is set', () => {
    const ch = EmailChannelFactory.fromEnv({
      LUMIBASE_ENV: 'production',
      LUMIBASE_RUNTIME: 'docker',
      LUMIBASE_SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
    } as never);
    expect(ch).toBeInstanceOf(SecurityEmailChannel);
    expect(ch?.name).toBe('email');
  });

  it('defaults to docker runtime when LUMIBASE_RUNTIME is unset', () => {
    const ch = EmailChannelFactory.fromEnv({
      LUMIBASE_ENV: 'production',
      LUMIBASE_SMTP_URL: 'smtp://localhost:1025',
    } as never);
    expect(ch).toBeInstanceOf(SecurityEmailChannel);
  });

  it('returns null on Docker runtime when SMTP URL is unset (degraded mode)', () => {
    const ch = EmailChannelFactory.fromEnv({
      LUMIBASE_ENV: 'production',
      LUMIBASE_RUNTIME: 'docker',
    } as never);
    expect(ch).toBeNull();
  });
});

// ── SecurityEmailChannel over a MailChannels transport ─────────────────

describe('SecurityEmailChannel (MailChannels transport)', () => {
  const makeChannel = (recipients: string[], fetchMock: typeof fetch) =>
    new SecurityEmailChannel(new MailchannelsTransport(fetchMock), {
      from: 'security@example.test',
      recipients,
    });

  it('POSTs to the MailChannels endpoint with the canonical payload', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('', { status: 202 }),
    );
    const ch = makeChannel(['ops@example.test'], fetchMock);

    const result = await ch.send(samplePayload);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('https://api.mailchannels.net/tx/v1/send');
    const init = call[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.subject).toBe('[LumiBase Security] anomaly_triggered');
    expect(body.from).toEqual({ email: 'security@example.test' });
    // Recipients merge: configured + payload.email, deduped.
    expect(body.personalizations[0].to).toEqual([
      { email: 'ops@example.test' },
      { email: 'admin@example.com' },
    ]);
    expect(body.content[0].type).toBe('text/plain');
    expect(body.content[0].value).toContain('admin@example.com');
  });

  it('returns retryable=false on 4xx responses', async () => {
    const fetchMock = vi.fn(
      async () => new Response('bad request', { status: 400 }),
    ) as unknown as typeof fetch;
    const result = await makeChannel([], fetchMock).send(samplePayload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('400');
    }
  });

  it('returns retryable=true on 5xx responses', async () => {
    const fetchMock = vi.fn(
      async () => new Response('overloaded', { status: 503 }),
    ) as unknown as typeof fetch;
    const result = await makeChannel([], fetchMock).send(samplePayload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('503');
    }
  });

  it('returns retryable=true on network errors', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const result = await makeChannel([], fetchMock).send(samplePayload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('network down');
    }
  });

  it('fails non-retryably with no recipients before contacting the transport', async () => {
    const fetchMock = vi.fn();
    const ch = makeChannel([], fetchMock as unknown as typeof fetch);
    // payload.email empty — channel merge yields zero recipients.
    const result = await ch.send({ ...samplePayload, email: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('no-recipients');
      expect(result.retryable).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('de-duplicates recipients case-insensitively', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('', { status: 202 }),
    );
    // 'Admin@Example.Com' collides with payload.email after lowercase.
    const ch = makeChannel(['Admin@Example.Com'], fetchMock);
    await ch.send(samplePayload);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.personalizations[0].to).toHaveLength(1);
  });
});

// ── SecurityEmailChannel over an SMTP transport ────────────────────────

describe('SecurityEmailChannel (SMTP transport)', () => {
  it('produces a DeliveryResult shape rather than throwing on a misconfigured URL', async () => {
    // nodemailer's createTransport tolerates many shapes, so we only
    // assert the channel never throws and always returns the {ok: ...}
    // contract.
    const ch = new SecurityEmailChannel(
      new NodemailerTransport('not-a-real-smtp-url'),
      { from: 'security@example.test', recipients: [] },
    );
    const result = await ch.send(samplePayload);
    expect(result).toHaveProperty('ok');
    expect(typeof result.ok).toBe('boolean');
  });

  it('fails non-retryably with no recipients before contacting the transport', async () => {
    const ch = new SecurityEmailChannel(
      new NodemailerTransport('smtp://localhost:1025'),
      { from: 'security@example.test', recipients: [] },
    );
    const result = await ch.send({ ...samplePayload, email: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('no-recipients');
      expect(result.retryable).toBe(false);
    }
  });
});
