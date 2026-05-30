/**
 * Resolve the client IP for a Hono request following design §6.1
 * (admin-setup-wizard, task 5.4).
 *
 * The Login_Guard derives counter keys (Req 8.1) and audit-log entries
 * (Req 15.2) from this IP, so resolution must follow the trust order
 * in Req 8.4 exactly:
 *
 *   1. **`CF-Connecting-IP`** — only Cloudflare's edge can set this
 *      header on the request that hits the Worker, so it's always
 *      trusted when present.
 *   2. **`X-Forwarded-For`** — *only* honoured when the immediate TCP
 *      peer (the request's remote socket address) is listed in
 *      `LUMIBASE_TRUSTED_PROXIES`. Untrusted clients may otherwise
 *      forge the header to spoof their IP and bypass the IP rate
 *      limiter (Req 8.2). When honoured, the *first* entry of the
 *      comma-separated list is taken — that's the original client per
 *      RFC 7239 §5.2.
 *   3. **Remote socket address** — the final fallback when no header
 *      survives, i.e. the bare TCP peer.
 *
 * Loopback addresses are canonicalised to `'127.0.0.1'` or `'::1'` so
 * the dev-bypass in Req 8.5 (`LUMIBASE_DEV_AUTH=true` skips IP rate
 * limiting from loopback) doesn't have to chase IPv4-mapped IPv6
 * (`::ffff:127.0.0.1`) or expanded IPv6 (`0:0:0:0:0:0:0:1`) variants
 * downstream.
 *
 * The function deliberately doesn't import the runtime-specific
 * `getConnInfo` helper from `@hono/node-server` or
 * `hono/cloudflare-workers/conninfo` — pulling either would break
 * portability between deploys (the CMS runs in both Node and Workers
 * per `apps/cms/src/serve.ts` and Wrangler). Instead the caller can
 * inject a {@link ExtractClientIpOptions.getRemoteAddress} resolver;
 * tests do the same. The wiring task at 6.1 will pass the appropriate
 * adapter from the runtime layer.
 *
 * Validates: Requirement 8.4 (design §6.1).
 */

import type { Context } from 'hono';
import type { AppEnv } from '../../env';

const CF_CONNECTING_IP = 'cf-connecting-ip';
const X_FORWARDED_FOR = 'x-forwarded-for';
const TRUSTED_PROXIES_ENV = 'LUMIBASE_TRUSTED_PROXIES';

/** Canonical loopback strings used by Req 8.5's dev bypass. */
const LOOPBACK_V4 = '127.0.0.1' as const;
const LOOPBACK_V6 = '::1' as const;
const FALLBACK_UNKNOWN = 'unknown';

/**
 * Per-call hooks for {@link extractClientIp}. Production wires
 * `getRemoteAddress` from the runtime adapter (Node socket / Workers
 * `cf` blob); tests inject a stub so the resolver itself can be
 * exercised without a server.
 */
export interface ExtractClientIpOptions {
  /**
   * Resolve the immediate TCP peer's address. Returning `null` /
   * `undefined` means "no remote info available" (typical on Workers,
   * where CF-Connecting-IP is the canonical source).
   */
  getRemoteAddress?: (c: Context<AppEnv>) => string | null | undefined;
}

/**
 * Resolve the client IP for the current Hono request.
 *
 * @returns A non-empty string. Falls back to `'unknown'` only when
 *          every signal is missing — that string is intentionally not
 *          a valid IP so it can't accidentally collide with a real
 *          counter key.
 */
export function extractClientIp(
  c: Context<AppEnv>,
  options?: ExtractClientIpOptions,
): string {
  // 1. CF-Connecting-IP — always trusted.
  const cfRaw = c.req.header(CF_CONNECTING_IP);
  const cf = sanitizeHeader(cfRaw);
  if (cf) return canonicalLoopback(cf);

  // Resolve remote socket once; both the trusted-proxy gate and the
  // final fallback need it.
  const remote = sanitizeHeader(options?.getRemoteAddress?.(c));
  const remoteCanon = remote ? canonicalLoopback(remote) : null;

  // 2. X-Forwarded-For — gated on the remote being a trusted proxy.
  const xffRaw = c.req.header(X_FORWARDED_FOR);
  if (xffRaw && remoteCanon) {
    const trustedCsv = readEnvString(c, TRUSTED_PROXIES_ENV);
    if (isTrustedProxy(remoteCanon, trustedCsv)) {
      const first = parseFirstForwardedFor(xffRaw);
      if (first) return canonicalLoopback(first);
    }
  }

  // 3. Remote socket fallback.
  if (remoteCanon) return remoteCanon;

  return FALLBACK_UNKNOWN;
}

// ── Loopback canonicalisation ───────────────────────────────────────────

/**
 * Canonicalise loopback IPs. Only the exact loopback addresses listed
 * in Req 8.5 are normalised — non-loopback IPs are returned unchanged
 * (after trimming). Specifically:
 *
 *   - `127.0.0.1` → `'127.0.0.1'`
 *   - `::1` and any equivalent IPv6 byte pattern (compressed,
 *     fully-expanded with leading zeros, etc.) → `'::1'`
 *   - `::ffff:127.0.0.1` (IPv4-mapped IPv6 loopback, in any of its
 *     written forms) → `'127.0.0.1'`
 *
 * Other IPv4 addresses in `127.0.0.0/8` are left as-is — the spec only
 * gives `127.0.0.1` and `::1` as canonical loopback forms (Req 8.5).
 * Mapping the entire /8 would change behaviour for operators who
 * deliberately use a non-`.1` loopback for diagnostics.
 *
 * Implementation note: rather than enumerate every textual form of
 * the loopback addresses, we delegate to {@link parseIpToBytes} and
 * compare the parsed byte pattern. That keeps the canonicaliser in
 * lockstep with the IP parser used for trusted-proxy CIDR matching —
 * if a form is recognised by one, it's recognised by the other.
 */
export function canonicalLoopback(ip: string): string {
  const trimmed = ip.trim();
  if (trimmed.length === 0) return trimmed;

  const bytes = parseIpToBytes(trimmed);
  if (bytes && isLoopbackBytes(bytes)) {
    return bytes.length === 4 ? LOOPBACK_V4 : LOOPBACK_V6;
  }

  return trimmed;
}

/**
 * Byte-level loopback check. Folded IPv4 (4 bytes) matches `127.x.x.x`
 * with the final octet being `1`; full IPv6 (16 bytes) matches
 * `::1` exactly.
 */
function isLoopbackBytes(bytes: Uint8Array): boolean {
  if (bytes.length === 4) {
    return (
      bytes[0] === 127 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 1
    );
  }
  if (bytes.length === 16) {
    for (let i = 0; i < 15; i++) {
      if (bytes[i] !== 0) return false;
    }
    return bytes[15] === 1;
  }
  return false;
}

// ── Trusted proxy matching (CIDR + literal) ─────────────────────────────

/**
 * `true` when `remote` (already canonicalised) matches any entry of
 * `trustedCsv`. Entries may be:
 *
 *   - A bare IP literal (`'10.0.0.5'` / `'::1'`) — exact match after
 *     canonicalisation.
 *   - A CIDR block (`'10.0.0.0/8'`, `'2001:db8::/32'`) — prefix-bit
 *     match on the parsed byte representation.
 *
 * Malformed entries are ignored rather than throwing — operators
 * shouldn't see a 500 because of a typo in env config; a malformed
 * entry simply doesn't trust anything.
 */
export function isTrustedProxy(
  remote: string,
  trustedCsv: string | undefined,
): boolean {
  if (!trustedCsv) return false;

  const remoteBytes = parseIpToBytes(remote);

  for (const rawEntry of trustedCsv.split(',')) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;

    const slash = entry.indexOf('/');
    if (slash === -1) {
      // Bare literal — compare canonicalised strings so loopback
      // variants in env (`::ffff:127.0.0.1`) still match the
      // canonicalised remote.
      if (canonicalLoopback(entry) === remote) return true;
      continue;
    }

    if (!remoteBytes) continue;

    const networkStr = entry.slice(0, slash);
    const prefixStr = entry.slice(slash + 1);
    const prefix = Number.parseInt(prefixStr, 10);
    if (!Number.isFinite(prefix) || prefix < 0) continue;

    const networkBytes = parseIpToBytes(networkStr);
    if (!networkBytes) continue;
    if (networkBytes.length !== remoteBytes.length) continue;
    if (prefix > networkBytes.length * 8) continue;

    if (cidrPrefixMatches(remoteBytes, networkBytes, prefix)) return true;
  }

  return false;
}

function cidrPrefixMatches(
  ip: Uint8Array,
  network: Uint8Array,
  prefix: number,
): boolean {
  let bitsLeft = prefix;
  for (let i = 0; i < ip.length && bitsLeft > 0; i++) {
    if (bitsLeft >= 8) {
      if (ip[i] !== network[i]) return false;
      bitsLeft -= 8;
    } else {
      const mask = (0xff << (8 - bitsLeft)) & 0xff;
      if ((ip[i]! & mask) !== (network[i]! & mask)) return false;
      bitsLeft = 0;
    }
  }
  return true;
}

// ── IP parsing ──────────────────────────────────────────────────────────

/**
 * Parse an IP literal into its raw bytes. Returns `null` on anything
 * that isn't a syntactically-valid IPv4 or IPv6 address. Supports:
 *
 *   - Dotted IPv4 (`'10.0.0.1'`).
 *   - IPv4-mapped IPv6 (`'::ffff:10.0.0.1'`) → 4-byte IPv4
 *     representation, so it matches against IPv4 CIDRs in the trusted
 *     proxy list.
 *   - Compressed IPv6 (`'::1'`, `'2001:db8::1'`) → 16 bytes.
 *
 * Zone identifiers (`'fe80::1%eth0'`) are stripped before parsing.
 */
export function parseIpToBytes(ip: string): Uint8Array | null {
  const trimmed = ip.trim();
  if (trimmed.length === 0) return null;

  // IPv4 dotted-quad.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    return parseIpv4(trimmed);
  }

  // Strip zone id before IPv6 parsing.
  const lower = trimmed.toLowerCase();
  const zoneIdx = lower.indexOf('%');
  const noZone = zoneIdx === -1 ? lower : lower.slice(0, zoneIdx);
  // Allow IPv6 + optional embedded IPv4 trailer.
  if (!/^[0-9a-f:.]+$/.test(noZone)) return null;
  return parseIpv6(noZone);
}

function parseIpv4(ip: string): Uint8Array | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number.parseInt(parts[i]!, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

function parseIpv6(ip: string): Uint8Array | null {
  // Reject `:::` and friends — at most one `::` is allowed.
  const dcMatches = ip.match(/::/g);
  if (dcMatches && dcMatches.length > 1) return null;

  // Detect a trailing IPv4 dotted-quad (RFC 4291 §2.2.3). It expands
  // into the final two 16-bit groups, e.g.
  // `0:0:0:0:0:ffff:127.0.0.1` becomes
  // `0:0:0:0:0:ffff:7f00:0001` (16-byte form). After folding, the
  // remainder of the string is parsed by the standard IPv6 path.
  let trailingV4Bytes: Uint8Array | null = null;
  const lastColon = ip.lastIndexOf(':');
  const tail = lastColon === -1 ? '' : ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    trailingV4Bytes = parseIpv4(tail);
    if (!trailingV4Bytes) return null;
    ip = ip.slice(0, lastColon);
    // `::ffff:127.0.0.1` → after slicing tail+last colon we get
    // `::ffff`, which is not a valid IPv6 (would need 7 colons or a
    // `::`). The trick: append the two reconstructed hex groups so
    // the rest of the IPv6 parsing path produces 16 bytes correctly.
    const hi =
      ((trailingV4Bytes[0]! << 8) | trailingV4Bytes[1]!).toString(16);
    const lo =
      ((trailingV4Bytes[2]! << 8) | trailingV4Bytes[3]!).toString(16);
    ip = `${ip}:${hi}:${lo}`;
  }

  const dcIdx = ip.indexOf('::');
  let groups: string[];
  if (dcIdx === -1) {
    groups = ip.split(':');
    if (groups.length !== 8) return null;
  } else {
    const left = ip.slice(0, dcIdx);
    const right = ip.slice(dcIdx + 2);
    const leftGroups = left.length > 0 ? left.split(':') : [];
    const rightGroups = right.length > 0 ? right.split(':') : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 0) return null;
    groups = [
      ...leftGroups,
      ...Array<string>(missing).fill('0'),
      ...rightGroups,
    ];
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (g.length === 0 || g.length > 4) return null;
    const n = Number.parseInt(g, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }

  // IPv4-mapped IPv6 (`::ffff:a.b.c.d` and its expanded form): fold
  // back to the 4 IPv4 bytes so trusted-proxy CIDRs declared as IPv4
  // (`10.0.0.0/8`) still match a Workers-surfaced IPv4-mapped peer
  // and so {@link canonicalLoopback} can normalise to `127.0.0.1`.
  if (isV4MappedPrefix(bytes)) {
    return bytes.slice(12, 16);
  }
  return bytes;
}

/**
 * `true` when the 16-byte IPv6 representation has the IPv4-mapped
 * prefix (`::ffff:`), i.e. ten leading zero bytes followed by
 * `0xff 0xff`.
 */
function isV4MappedPrefix(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

// ── Header / env helpers ────────────────────────────────────────────────

/**
 * Trim a header / resolver value and reject blank inputs. Returns
 * `null` for any falsy or whitespace-only value so the caller can
 * cleanly fall through to the next signal in the chain.
 */
function sanitizeHeader(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Pluck the original-client IP from an X-Forwarded-For header.
 *
 * RFC 7239 §5.2 and de-facto behaviour: clients are appended on the
 * right, so the *first* entry is the original client. We split on
 * commas (XFF allows multiple proxy hops) and trim each candidate.
 * Empty entries (`'  ,1.2.3.4'`) are skipped so an attacker can't
 * blank out the header to confuse the parser.
 */
export function parseFirstForwardedFor(xff: string): string | null {
  for (const raw of xff.split(',')) {
    const candidate = raw.trim();
    if (candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * Read a string env var off Hono's bindings. Returns `undefined` for
 * missing or non-string values so {@link isTrustedProxy} can no-op
 * without an extra type guard at the call site.
 */
function readEnvString(
  c: Context<AppEnv>,
  key: string,
): string | undefined {
  const env = c.env as unknown as Record<string, unknown> | undefined;
  if (!env) return undefined;
  const value = env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
