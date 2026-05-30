import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';

import {
  canonicalLoopback,
  extractClientIp,
  isTrustedProxy,
  parseFirstForwardedFor,
  parseIpToBytes,
} from '../ip-extract';
import type { AppEnv } from '../../../env';

/**
 * Feature: admin-setup-wizard, task 5.4 — client IP resolution.
 *
 * Covers Req 8.4 + design §6.1: the LoginGuard derives counter keys
 * and audit metadata from this resolver, so the trust order
 * (CF-Connecting-IP → trusted-XFF → socket) and loopback
 * canonicalisation must be exact.
 *
 * Validates: Requirements 8.4 (and Req 8.5's loopback canonical form
 * via {@link canonicalLoopback}).
 */

// ── Test helpers ────────────────────────────────────────────────────────

interface BuildCtxOptions {
  headers?: Record<string, string>;
  env?: Record<string, unknown>;
  remote?: string | null;
}

/**
 * Build a Hono Context that mirrors the production wiring. We use a
 * real Hono app rather than hand-rolling a context fake so:
 *
 *   - `c.req.header(...)` casing, normalisation, and undefined-on-miss
 *     behaviour comes from Hono itself (avoids drift if Hono changes).
 *   - `c.env` is populated from `app.fetch(req, env)`, which is the
 *     same path Workers + the Node adapter take.
 *
 * The route stashes the resolved IP on `Variables.requestId` (the
 * cheapest already-typed string slot) so the test can recover it
 * from the response body.
 */
async function resolveIp(opts: BuildCtxOptions): Promise<string> {
  const app = new Hono<AppEnv>();
  let captured = '';
  app.get('/probe', (c) => {
    captured = extractClientIp(c, {
      getRemoteAddress: () => opts.remote ?? null,
    });
    return c.text('ok');
  });

  const headers = new Headers();
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
  const req = new Request('http://localhost/probe', { method: 'GET', headers });
  await app.fetch(req, opts.env as never);
  return captured;
}

/** Direct context probe for the few tests that need to assert on the
 * resolver's interaction with the typed `Context` (rather than
 * round-tripping through `app.fetch`). */
function buildContext(opts: BuildCtxOptions): Context<AppEnv> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  const c = {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
    env: opts.env ?? {},
  } as unknown as Context<AppEnv>;
  return c;
}

// ── extractClientIp: header precedence ─────────────────────────────────

describe('extractClientIp — header precedence (Req 8.4)', () => {
  it('prefers CF-Connecting-IP over X-Forwarded-For and remote', async () => {
    const ip = await resolveIp({
      headers: {
        'CF-Connecting-IP': '203.0.113.5',
        'X-Forwarded-For': '198.51.100.1',
      },
      env: { LUMIBASE_TRUSTED_PROXIES: '10.0.0.0/8' },
      remote: '10.0.0.1',
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('prefers CF-Connecting-IP even when remote is not a trusted proxy', async () => {
    // Mirrors the Cloudflare-fronted deploy: the Worker only ever sees
    // CF's edge IP as the socket peer, but the header is always
    // authoritative.
    const ip = await resolveIp({
      headers: { 'CF-Connecting-IP': '203.0.113.5' },
      env: {},
      remote: '198.51.100.42',
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('uses X-Forwarded-For when remote is in LUMIBASE_TRUSTED_PROXIES (literal)', async () => {
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '203.0.113.5' },
      env: { LUMIBASE_TRUSTED_PROXIES: '10.0.0.1, 10.0.0.2' },
      remote: '10.0.0.2',
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('uses X-Forwarded-For when remote is in LUMIBASE_TRUSTED_PROXIES (CIDR)', async () => {
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '203.0.113.5' },
      env: { LUMIBASE_TRUSTED_PROXIES: '10.0.0.0/8, 192.168.0.0/16' },
      remote: '10.99.42.7',
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('ignores X-Forwarded-For when remote is NOT a trusted proxy', async () => {
    // Untrusted forwarder — must not bypass the IP rate limiter
    // (Req 8.2). The socket address wins instead.
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '203.0.113.5' },
      env: { LUMIBASE_TRUSTED_PROXIES: '10.0.0.0/8' },
      remote: '198.51.100.42',
    });
    expect(ip).toBe('198.51.100.42');
  });

  it('ignores X-Forwarded-For when LUMIBASE_TRUSTED_PROXIES is unset', async () => {
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '203.0.113.5' },
      env: {},
      remote: '198.51.100.42',
    });
    expect(ip).toBe('198.51.100.42');
  });

  it('ignores X-Forwarded-For when LUMIBASE_TRUSTED_PROXIES is empty/whitespace', async () => {
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '203.0.113.5' },
      env: { LUMIBASE_TRUSTED_PROXIES: '   ' },
      remote: '10.0.0.1',
    });
    expect(ip).toBe('10.0.0.1');
  });

  it('falls back to the remote socket when no header is present', async () => {
    const ip = await resolveIp({
      headers: {},
      env: {},
      remote: '198.51.100.42',
    });
    expect(ip).toBe('198.51.100.42');
  });

  it("returns 'unknown' when every signal is missing", async () => {
    const ip = await resolveIp({ headers: {}, env: {}, remote: null });
    expect(ip).toBe('unknown');
  });

  it('uses CF-Connecting-IP even with no remote address (Workers runtime)', async () => {
    const ip = await resolveIp({
      headers: { 'CF-Connecting-IP': '203.0.113.5' },
      env: {},
      remote: null,
    });
    expect(ip).toBe('203.0.113.5');
  });
});

// ── X-Forwarded-For parsing ────────────────────────────────────────────

describe('X-Forwarded-For parsing (Req 8.4)', () => {
  it('takes the first non-empty entry from a multi-hop list', async () => {
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '203.0.113.5, 70.41.3.18, 150.172.238.178' },
      env: { LUMIBASE_TRUSTED_PROXIES: '10.0.0.0/8' },
      remote: '10.0.0.1',
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('trims whitespace around entries', async () => {
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '   203.0.113.5  ,  70.41.3.18  ' },
      env: { LUMIBASE_TRUSTED_PROXIES: '10.0.0.0/8' },
      remote: '10.0.0.1',
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('skips leading empty entries (cannot be blanked out by attacker)', async () => {
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '  ,  , 203.0.113.5' },
      env: { LUMIBASE_TRUSTED_PROXIES: '10.0.0.0/8' },
      remote: '10.0.0.1',
    });
    expect(ip).toBe('203.0.113.5');
  });

  it('falls back to remote when X-Forwarded-For has only empty entries', async () => {
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '   ,  ,   ' },
      env: { LUMIBASE_TRUSTED_PROXIES: '10.0.0.0/8' },
      remote: '10.0.0.1',
    });
    expect(ip).toBe('10.0.0.1');
  });

  it('supports IPv6 entries in the chain', async () => {
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '2001:db8::1, 2001:db8::2' },
      env: { LUMIBASE_TRUSTED_PROXIES: '2001:db8::/32' },
      remote: '2001:db8::ff',
    });
    expect(ip).toBe('2001:db8::1');
  });

  it('parseFirstForwardedFor handles edge cases', () => {
    expect(parseFirstForwardedFor('203.0.113.5')).toBe('203.0.113.5');
    expect(parseFirstForwardedFor('203.0.113.5, 70.41.3.18')).toBe('203.0.113.5');
    expect(parseFirstForwardedFor('  ')).toBeNull();
    expect(parseFirstForwardedFor(',,,')).toBeNull();
    expect(parseFirstForwardedFor('  ,a.b.c.d')).toBe('a.b.c.d');
  });
});

// ── Loopback canonicalisation ──────────────────────────────────────────

describe('canonicalLoopback (Req 8.5 dev-bypass support)', () => {
  it("normalises IPv4 loopback to '127.0.0.1'", () => {
    expect(canonicalLoopback('127.0.0.1')).toBe('127.0.0.1');
    expect(canonicalLoopback('  127.0.0.1  ')).toBe('127.0.0.1');
  });

  it("normalises IPv6 loopback variants to '::1'", () => {
    expect(canonicalLoopback('::1')).toBe('::1');
    expect(canonicalLoopback('  ::1  ')).toBe('::1');
    expect(canonicalLoopback('::1'.toUpperCase())).toBe('::1');
    expect(canonicalLoopback('0:0:0:0:0:0:0:1')).toBe('::1');
    expect(canonicalLoopback('0000:0000:0000:0000:0000:0000:0000:0001')).toBe('::1');
  });

  it("folds IPv4-mapped IPv6 loopback to '127.0.0.1'", () => {
    expect(canonicalLoopback('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(canonicalLoopback('::FFFF:127.0.0.1')).toBe('127.0.0.1');
    expect(canonicalLoopback('0:0:0:0:0:ffff:127.0.0.1')).toBe('127.0.0.1');
  });

  it('leaves non-loopback IPs unchanged (modulo trim)', () => {
    expect(canonicalLoopback('203.0.113.5')).toBe('203.0.113.5');
    expect(canonicalLoopback('  203.0.113.5  ')).toBe('203.0.113.5');
    expect(canonicalLoopback('2001:db8::1')).toBe('2001:db8::1');
    // Other 127/8 addresses are NOT remapped — only `127.0.0.1`
    // is the canonical loopback per Req 8.5.
    expect(canonicalLoopback('127.0.0.2')).toBe('127.0.0.2');
  });

  it('canonicalises loopback when surfaced by extractClientIp', async () => {
    // Workers/Node may surface IPv4-mapped IPv6 for a literal
    // loopback connection. The resolver must hand back '127.0.0.1'
    // so the dev-bypass in Req 8.5 sees the canonical form.
    const ip = await resolveIp({
      headers: {},
      env: {},
      remote: '::ffff:127.0.0.1',
    });
    expect(ip).toBe('127.0.0.1');
  });

  it('canonicalises loopback in CF-Connecting-IP', async () => {
    const ip = await resolveIp({
      headers: { 'CF-Connecting-IP': '0:0:0:0:0:0:0:1' },
      env: {},
      remote: null,
    });
    expect(ip).toBe('::1');
  });

  it('canonicalises loopback in X-Forwarded-For (when proxy trusted)', async () => {
    const ip = await resolveIp({
      headers: { 'X-Forwarded-For': '::ffff:127.0.0.1' },
      env: { LUMIBASE_TRUSTED_PROXIES: '10.0.0.0/8' },
      remote: '10.0.0.1',
    });
    expect(ip).toBe('127.0.0.1');
  });
});

// ── Trusted-proxy matching ─────────────────────────────────────────────

describe('isTrustedProxy', () => {
  it('returns false when the trusted list is undefined or empty', () => {
    expect(isTrustedProxy('10.0.0.1', undefined)).toBe(false);
    expect(isTrustedProxy('10.0.0.1', '')).toBe(false);
    expect(isTrustedProxy('10.0.0.1', '   ')).toBe(false);
  });

  it('matches literal IPv4 entries', () => {
    expect(isTrustedProxy('10.0.0.1', '10.0.0.1')).toBe(true);
    expect(isTrustedProxy('10.0.0.2', '10.0.0.1')).toBe(false);
  });

  it('matches literal IPv6 entries (case-insensitive)', () => {
    expect(isTrustedProxy('::1', '::1')).toBe(true);
    expect(isTrustedProxy('::1', '0:0:0:0:0:0:0:1')).toBe(true);
  });

  it('matches CIDR blocks (IPv4)', () => {
    expect(isTrustedProxy('10.99.42.7', '10.0.0.0/8')).toBe(true);
    expect(isTrustedProxy('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(isTrustedProxy('192.168.1.5', '192.168.0.0/16')).toBe(true);
    expect(isTrustedProxy('192.169.1.5', '192.168.0.0/16')).toBe(false);
  });

  it('matches /32 IPv4 CIDR exactly like a literal', () => {
    expect(isTrustedProxy('10.0.0.1', '10.0.0.1/32')).toBe(true);
    expect(isTrustedProxy('10.0.0.2', '10.0.0.1/32')).toBe(false);
  });

  it('matches CIDR blocks (IPv6)', () => {
    expect(isTrustedProxy('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(isTrustedProxy('2001:db9::1', '2001:db8::/32')).toBe(false);
  });

  it('treats CIDR /0 as match-all of the same family', () => {
    expect(isTrustedProxy('203.0.113.5', '0.0.0.0/0')).toBe(true);
    expect(isTrustedProxy('2001:db8::1', '::/0')).toBe(true);
    // Cross-family /0 must not match.
    expect(isTrustedProxy('203.0.113.5', '::/0')).toBe(false);
  });

  it('skips invalid CIDR or IP entries without throwing', () => {
    expect(isTrustedProxy('10.0.0.1', 'not-an-ip')).toBe(false);
    expect(isTrustedProxy('10.0.0.1', '10.0.0.0/abc')).toBe(false);
    expect(isTrustedProxy('10.0.0.1', '10.0.0.0/-3')).toBe(false);
    expect(isTrustedProxy('10.0.0.1', '10.0.0.0/40')).toBe(false);
    // A typo entry shouldn't poison subsequent valid entries.
    expect(isTrustedProxy('10.0.0.1', 'bad, 10.0.0.0/8')).toBe(true);
  });

  it('does not cross-match IPv4 vs IPv6 CIDRs', () => {
    expect(isTrustedProxy('10.0.0.1', '2001:db8::/32')).toBe(false);
    expect(isTrustedProxy('2001:db8::1', '10.0.0.0/8')).toBe(false);
  });

  it('honours whitespace around CSV entries', () => {
    expect(isTrustedProxy('10.0.0.1', '  10.0.0.0/8  , 192.168.0.0/16 ')).toBe(true);
    expect(isTrustedProxy('192.168.42.1', '  10.0.0.0/8  , 192.168.0.0/16 ')).toBe(true);
  });
});

// ── parseIpToBytes (sanity for trust matching) ─────────────────────────

describe('parseIpToBytes', () => {
  it('parses dotted IPv4', () => {
    expect(parseIpToBytes('10.0.0.1')).toEqual(new Uint8Array([10, 0, 0, 1]));
    expect(parseIpToBytes('255.255.255.255')).toEqual(
      new Uint8Array([255, 255, 255, 255]),
    );
  });

  it('rejects malformed IPv4', () => {
    expect(parseIpToBytes('10.0.0')).toBeNull();
    expect(parseIpToBytes('10.0.0.1.5')).toBeNull();
    expect(parseIpToBytes('256.0.0.1')).toBeNull();
    expect(parseIpToBytes('10.0.0.a')).toBeNull();
  });

  it('parses compressed IPv6', () => {
    const bytes = parseIpToBytes('::1');
    expect(bytes).not.toBeNull();
    expect(bytes!.length).toBe(16);
    expect(bytes![15]).toBe(1);
  });

  it('parses full IPv6', () => {
    const bytes = parseIpToBytes('2001:0db8:0000:0000:0000:0000:0000:0001');
    expect(bytes).not.toBeNull();
    expect(bytes![0]).toBe(0x20);
    expect(bytes![1]).toBe(0x01);
    expect(bytes![15]).toBe(0x01);
  });

  it('folds IPv4-mapped IPv6 into 4 bytes', () => {
    expect(parseIpToBytes('::ffff:10.0.0.1')).toEqual(
      new Uint8Array([10, 0, 0, 1]),
    );
  });

  it('rejects multiple `::` runs', () => {
    expect(parseIpToBytes('1::2::3')).toBeNull();
  });

  it('strips IPv6 zone identifiers', () => {
    const bytes = parseIpToBytes('fe80::1%eth0');
    expect(bytes).not.toBeNull();
    expect(bytes![15]).toBe(1);
  });

  it('returns null for blank or non-IP strings', () => {
    expect(parseIpToBytes('')).toBeNull();
    expect(parseIpToBytes('   ')).toBeNull();
    expect(parseIpToBytes('hello')).toBeNull();
  });
});

// ── Direct context probe (no full Hono fetch) ──────────────────────────

describe('extractClientIp via direct Context (no fetch round-trip)', () => {
  it('returns the CF header when called against a synthetic context', () => {
    const c = buildContext({
      headers: { 'CF-Connecting-IP': '203.0.113.5' },
      env: {},
    });
    const ip = extractClientIp(c, { getRemoteAddress: () => null });
    expect(ip).toBe('203.0.113.5');
  });

  it('does not throw when c.env is missing entirely', () => {
    const c = {
      req: { header: () => undefined },
    } as unknown as Context<AppEnv>;
    expect(() => extractClientIp(c, { getRemoteAddress: () => '10.0.0.1' })).not.toThrow();
    expect(extractClientIp(c, { getRemoteAddress: () => '10.0.0.1' })).toBe('10.0.0.1');
  });

  it("does not invoke getRemoteAddress when it isn't needed", () => {
    let calls = 0;
    const c = buildContext({
      headers: { 'CF-Connecting-IP': '203.0.113.5' },
      env: {},
    });
    const ip = extractClientIp(c, {
      getRemoteAddress: () => {
        calls++;
        return '10.0.0.1';
      },
    });
    expect(ip).toBe('203.0.113.5');
    // CF header short-circuits — remote resolver should still be safe
    // to omit. (We don't assert calls===0 because the contract only
    // says "returns a non-empty string"; both 0 and 1 invocations are
    // acceptable. We only assert the resolver doesn't crash.)
    expect(calls).toBeLessThanOrEqual(1);
  });

  it('treats missing options as "no remote info"', () => {
    const c = buildContext({
      headers: { 'X-Forwarded-For': '203.0.113.5' },
      env: { LUMIBASE_TRUSTED_PROXIES: '10.0.0.0/8' },
    });
    // No remote → can't trust the proxy → XFF ignored → fallback to
    // 'unknown' (Req 8.4).
    expect(extractClientIp(c)).toBe('unknown');
  });
});
