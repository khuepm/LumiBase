import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildCanonicalBody,
  DEFAULT_TIMEOUT_MS,
  hmacSha256Hex,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  WebhookChannel,
  WebhookChannelFactory,
} from '../webhook-channel';
import type { NotificationPayload } from '../types';

/**
 * Feature: admin-setup-wizard, task 9.3 — webhook notification
 * channel.
 *
 * Coverage:
 *
 *   1. Canonical body — fixed key order matching Req 13.3, byte
 *      stable across calls.
 *   2. HMAC signing — `X-Lumibase-Signature: sha256=<hex>` and
 *      `X-Lumibase-Timestamp` are computed over `${timestamp}.${body}`
 *      with the operator-supplied secret (design §7.4).
 *   3. Status code branches — 2xx ok, 4xx non-retryable, 5xx
 *      retryable, network / timeout retryable (design §9.3).
 *   4. Timeout — request is aborted after `timeoutMs` and surfaces
 *      as `webhook-timeout`.
 *   5. Factory — `fromPolicy` returns `null` when `webhookUrl` or
 *      `webhookSecret` is missing/empty (design §12.3).
 *
 * **Validates: Requirements 13.3 — see also design §9.3, §7.4.**
 */

const samplePayload: NotificationPayload = {
  event: 'user_locked',
  timestamp: '2025-01-15T10:20:30.000Z',
  email: 'admin@example.com',
  ip: '203.0.113.5',
  country: 'US',
  userAgent: 'Mozilla/5.0',
  anomalyScore: null,
  action: 'locked',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── Canonical body ────────────────────────────────────────────────────

describe('buildCanonicalBody', () => {
  it('emits keys in the order documented in Req 13.3', () => {
    const body = buildCanonicalBody(samplePayload);
    // Req 13.3 wire shape: {event, timestamp, email, ip, country,
    // userAgent, anomalyScore, action}.
    expect(body).toBe(
      JSON.stringify({
        event: 'user_locked',
        timestamp: '2025-01-15T10:20:30.000Z',
        email: 'admin@example.com',
        ip: '203.0.113.5',
        country: 'US',
        userAgent: 'Mozilla/5.0',
        anomalyScore: null,
        action: 'locked',
      }),
    );
  });

  it('produces the same bytes for the same logical payload regardless of input key order', () => {
    const reordered: NotificationPayload = {
      action: 'locked',
      anomalyScore: null,
      userAgent: 'Mozilla/5.0',
      country: 'US',
      ip: '203.0.113.5',
      email: 'admin@example.com',
      timestamp: '2025-01-15T10:20:30.000Z',
      event: 'user_locked',
    };
    expect(buildCanonicalBody(reordered)).toBe(
      buildCanonicalBody(samplePayload),
    );
  });

  it('preserves null / numeric anomalyScore as-is on the wire', () => {
    const withScore = buildCanonicalBody({ ...samplePayload, anomalyScore: 0.85 });
    expect(JSON.parse(withScore).anomalyScore).toBe(0.85);

    const noScore = buildCanonicalBody(samplePayload);
    expect(JSON.parse(noScore).anomalyScore).toBeNull();
  });
});

// ── HMAC primitive ────────────────────────────────────────────────────

describe('hmacSha256Hex', () => {
  it('matches RFC 4231 test vector 1 (key=0x0b*20, data="Hi There")', async () => {
    // RFC 4231 §4.2 — canonical reference vector for HMAC-SHA-256.
    // Pinning a third-party vector means the project doesn't trust a
    // single runtime's `crypto.subtle` to be self-consistent; if any
    // upgrade silently changes behaviour, this test catches it.
    const key = String.fromCharCode(...new Array(20).fill(0x0b));
    const data = 'Hi There';
    const expected =
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7';
    expect(await hmacSha256Hex(key, data)).toBe(expected);
  });

  it('produces 64-char lowercase hex', async () => {
    const hex = await hmacSha256Hex('secret', 'message');
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Channel: success path + signing ───────────────────────────────────

describe('WebhookChannel.send — success + signing', () => {
  it('POSTs JSON to webhookUrl with HMAC-SHA256 signature header (design §7.4)', async () => {
    // Freeze the clock so the timestamp the channel computes is
    // deterministic and we can verify the exact signed bytes.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T10:20:30.000Z'));
    const expectedTimestamp = Math.floor(
      new Date('2025-01-15T10:20:30.000Z').getTime() / 1000,
    );

    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('ok', { status: 200 }),
    );
    const channel = new WebhookChannel(
      'https://hooks.example.test/lumibase',
      's3cret-rotated-quarterly',
      { fetchFn: fetchMock },
    );

    const result = await channel.send(samplePayload);
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://hooks.example.test/lumibase');

    const initObj = init as RequestInit & { headers: Record<string, string> };
    expect(initObj.method).toBe('POST');

    // Body must be the canonical projection — verify byte-for-byte.
    const expectedBody = buildCanonicalBody(samplePayload);
    expect(initObj.body).toBe(expectedBody);

    // Signature is HMAC-SHA256 over `${timestamp}.${body}`.
    const expectedSig = await hmacSha256Hex(
      's3cret-rotated-quarterly',
      `${expectedTimestamp}.${expectedBody}`,
    );

    const headers = initObj.headers;
    expect(headers['content-type']).toBe('application/json');
    expect(headers[SIGNATURE_HEADER]).toBe(`sha256=${expectedSig}`);
    expect(headers[TIMESTAMP_HEADER]).toBe(String(expectedTimestamp));
  });

  it('uses an integer unix-seconds timestamp (no decimals)', async () => {
    vi.useFakeTimers();
    // 10:20:30.567 UTC — fractional millis must be floored.
    vi.setSystemTime(new Date('2025-01-15T10:20:30.567Z'));
    const expectedTimestamp = Math.floor(
      new Date('2025-01-15T10:20:30.567Z').getTime() / 1000,
    );

    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('', { status: 200 }),
    );
    const channel = new WebhookChannel('https://hooks.example.test/x', 's', {
      fetchFn: fetchMock,
    });
    await channel.send(samplePayload);

    const init = fetchMock.mock.calls[0]![1] as RequestInit & {
      headers: Record<string, string>;
    };
    expect(init.headers[TIMESTAMP_HEADER]).toBe(String(expectedTimestamp));
    expect(init.headers[TIMESTAMP_HEADER]).not.toContain('.');
  });

  it('treats the entire 2xx range as success', async () => {
    for (const status of [200, 201, 202, 299]) {
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response('ok', { status }),
      );
      const channel = new WebhookChannel('https://e.test/x', 's', {
        fetchFn: fetchMock,
      });
      const result = await channel.send(samplePayload);
      expect(result).toEqual({ ok: true });
    }
  });
});

// ── Channel: failure branches ─────────────────────────────────────────

describe('WebhookChannel.send — failure branches', () => {
  it('returns retryable=false on 4xx responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('bad signature', { status: 401 }),
    );
    const channel = new WebhookChannel('https://e.test/x', 's', {
      fetchFn: fetchMock,
    });
    const result = await channel.send(samplePayload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(false);
      expect(result.error).toContain('401');
      expect(result.error).toContain('bad signature');
    }
  });

  it('returns retryable=true on 5xx responses', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('upstream', { status: 503 }),
    );
    const channel = new WebhookChannel('https://e.test/x', 's', {
      fetchFn: fetchMock,
    });
    const result = await channel.send(samplePayload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('503');
    }
  });

  it('returns retryable=true on network errors (DNS / connection refused)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new TypeError('connect ECONNREFUSED');
    });
    const channel = new WebhookChannel('https://e.test/x', 's', {
      fetchFn: fetchMock,
    });
    const result = await channel.send(samplePayload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toContain('ECONNREFUSED');
    }
  });

  it('aborts after timeoutMs and surfaces webhook-timeout', async () => {
    // Use a tight timeout and a fetch that resolves only after a
    // longer delay; the AbortController in the channel should fire
    // first and the result should reflect the timeout.
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          // Simulate a slow upstream: resolve only after 1s, but the
          // AbortController should cancel us before that.
          const timer = setTimeout(
            () => resolve(new Response('', { status: 200 })),
            1000,
          );
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const channel = new WebhookChannel('https://e.test/x', 's', {
      fetchFn: fetchMock,
      timeoutMs: 25,
    });
    const result = await channel.send(samplePayload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.error).toBe('webhook-timeout');
    }
  });

  it('defaults timeoutMs to 10s per design §9.3', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });
});

// ── Factory ───────────────────────────────────────────────────────────

describe('WebhookChannelFactory.fromPolicy', () => {
  it('returns a WebhookChannel when both webhookUrl and webhookSecret are set', () => {
    const channel = WebhookChannelFactory.fromPolicy({
      webhookUrl: 'https://hooks.example.test/lumibase',
      webhookSecret: 'top-secret',
    });
    expect(channel).toBeInstanceOf(WebhookChannel);
    expect(channel?.name).toBe('webhook');
  });

  it('returns null when webhookUrl is missing', () => {
    const channel = WebhookChannelFactory.fromPolicy({
      webhookSecret: 'top-secret',
    });
    expect(channel).toBeNull();
  });

  it('returns null when webhookSecret is missing', () => {
    const channel = WebhookChannelFactory.fromPolicy({
      webhookUrl: 'https://hooks.example.test/lumibase',
    });
    expect(channel).toBeNull();
  });

  it('returns null when webhookUrl is the empty string', () => {
    const channel = WebhookChannelFactory.fromPolicy({
      webhookUrl: '',
      webhookSecret: 'x',
    });
    expect(channel).toBeNull();
  });

  it('returns null when webhookSecret is the empty string', () => {
    const channel = WebhookChannelFactory.fromPolicy({
      webhookUrl: 'https://hooks.example.test/lumibase',
      webhookSecret: '',
    });
    expect(channel).toBeNull();
  });

  it('forwards opts (fetchFn, timeoutMs) to the constructed channel', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('', { status: 200 }),
    );
    const channel = WebhookChannelFactory.fromPolicy(
      {
        webhookUrl: 'https://hooks.example.test/lumibase',
        webhookSecret: 'x',
      },
      { fetchFn: fetchMock, timeoutMs: 5_000 },
    );
    expect(channel).not.toBeNull();
    await channel!.send(samplePayload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
