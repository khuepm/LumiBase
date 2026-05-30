/**
 * Detect "non-routable" IPs that the GeoIP subscore must skip per
 * Req 9.5 and design §8.1 (admin-setup-wizard Phase D, task 7.2).
 *
 * The geo detector consumes the canonicalised IP produced by
 * `extractClientIp` (login-guard task 5.4) — that helper folds
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) and equivalent loopback forms
 * down to `127.0.0.1` / `::1`, so this checker only has to recognise
 * the canonical text representations plus the standard private
 * ranges. Anything else (public IPv4/IPv6) is treated as routable so
 * the MMDB lookup runs.
 *
 * Spec coverage (design §8.1 phrasing: "RFC1918 + ::1 + 127.0.0.0/8"):
 *
 *   - IPv4 loopback `127.0.0.0/8`.
 *   - IPv4 private `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
 *     (RFC 1918).
 *   - IPv4 link-local `169.254.0.0/16` — included because GeoIP
 *     databases never resolve these; treating them as
 *     `geoLookupStatus='unavailable'` matches operator expectation.
 *   - IPv4 "unspecified" `0.0.0.0`.
 *   - IPv6 loopback `::1`.
 *   - IPv6 unspecified `::`.
 *   - IPv6 ULA `fc00::/7` (RFC 4193) — IPv6 equivalent of RFC 1918.
 *   - IPv6 link-local `fe80::/10` — same rationale as IPv4 169.254.
 *   - The literal `'unknown'` sentinel that {@link extractClientIp}
 *     emits when no IP signal is available; treating it as private
 *     short-circuits the lookup before maxmind sees an invalid input.
 *
 * Anything else returns `false` and the geo detector proceeds with
 * the MMDB lookup. The check is text-only (no `parseIpToBytes`) to
 * keep the hot path branch-free; the canonicalised input is already
 * deterministic so prefix matching is sufficient and obvious to read.
 */

const UNKNOWN_SENTINEL = 'unknown';

/**
 * `true` when the supplied IP must be skipped by the GeoIP lookup.
 *
 * The function is deliberately permissive on input: empty string,
 * whitespace, and the `'unknown'` sentinel from `extractClientIp` all
 * return `true` so the detector falls into the
 * `geoLookupStatus='unavailable'` branch rather than passing dubious
 * input into the MMDB reader. A canonical IPv4/IPv6 literal goes
 * through the prefix-match logic.
 */
export function isPrivateOrLoopback(ip: string | null | undefined): boolean {
  if (typeof ip !== 'string') return true;
  const trimmed = ip.trim();
  if (trimmed.length === 0) return true;
  if (trimmed === UNKNOWN_SENTINEL) return true;

  // IPv6 — handle before IPv4 because some literals contain dots
  // (`::ffff:1.2.3.4` would match the IPv4 path otherwise).
  if (trimmed.includes(':')) return isPrivateOrLoopbackV6(trimmed);

  return isPrivateOrLoopbackV4(trimmed);
}

// ── IPv4 ────────────────────────────────────────────────────────────────

/**
 * IPv4 prefix check. Validates dotted-quad shape first so a malformed
 * literal (`'10.foo'`) doesn't accidentally match `'10.'` and skip a
 * legitimate lookup.
 */
function isPrivateOrLoopbackV4(ip: string): boolean {
  const octets = ip.split('.');
  if (octets.length !== 4) return false;
  const [a, b] = octets.map((part) => Number.parseInt(part, 10));
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    a! < 0 ||
    a! > 255 ||
    b! < 0 ||
    b! > 255
  ) {
    return false;
  }

  // 0.0.0.0/32 — the unspecified address; never has a country.
  if (a === 0 && octets[1] === '0' && octets[2] === '0' && octets[3] === '0') {
    return true;
  }
  // 127.0.0.0/8 — loopback (Req 9.5; design §8.1).
  if (a === 127) return true;
  // RFC 1918 private ranges.
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b! >= 16 && b! <= 31) return true;
  // 169.254.0.0/16 — link-local; GeoIP can't resolve these.
  if (a === 169 && b === 254) return true;

  return false;
}

// ── IPv6 ────────────────────────────────────────────────────────────────

/**
 * IPv6 prefix check on the canonical text form (lowercased,
 * compressed). The geo detector receives canonicalised input from
 * `extractClientIp`, so we only need to recognise the canonical
 * spellings of the special-case prefixes plus a couple of
 * fully-expanded variants for safety.
 */
function isPrivateOrLoopbackV6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // ::1 loopback and `::` unspecified — exact matches on the
  // canonical compressed form.
  if (lower === '::1') return true;
  if (lower === '::') return true;

  // ULA `fc00::/7` — first byte in `0xfc` or `0xfd`. The first
  // address group is two hex digits plus optional leading zeros; we
  // match the leading hex group (1–4 chars) on `fc` or `fd`.
  if (/^fc[0-9a-f]{0,2}:/.test(lower)) return true;
  if (/^fd[0-9a-f]{0,2}:/.test(lower)) return true;

  // Link-local `fe80::/10` — first 10 bits are `1111 1110 10`, which
  // covers `fe80::` through `febf::`. The first hex group is `fe8x`,
  // `fe9x`, `feax`, or `febx`.
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;

  // Fully-expanded loopback / unspecified — be defensive in case a
  // caller skipped canonicalisation. Eight zero-groups with a
  // trailing `1` is loopback; eight zero-groups is unspecified.
  if (/^0(:0){6}:1$/.test(lower)) return true;
  if (/^0(:0){7}$/.test(lower)) return true;

  return false;
}
