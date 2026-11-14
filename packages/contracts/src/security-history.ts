/**
 * Per-user security history (#739, epic #674 S10) — the wire contract shared
 * by the CMS (`GET /api/v1/me/security-history`), the Studio "Security
 * history" section and the new-device sign-in email.
 */

/**
 * Friendly kinds a history item can carry. The CMS maps an allow-list of
 * audit event codes onto these; any audit code not mapped here is never
 * returned to the user.
 */
export const SECURITY_HISTORY_KINDS = [
  'sign_in',
  'sign_in_failed',
  'mfa_challenge_failed',
  'new_device',
  'suspicious_sign_in',
  'account_locked',
  'account_unlocked',
  'password_changed',
  'password_reset_requested',
  'password_reset',
  'mfa_enabled',
  'mfa_disabled',
  'session_revoked',
  'sessions_revoked',
  'session_token_reuse',
] as const;

export type SecurityHistoryKind = (typeof SECURITY_HISTORY_KINDS)[number];

/** One redacted entry of the caller's own security history. */
export interface SecurityHistoryItem {
  /** Opaque id of the underlying audit row. */
  id: string;
  kind: SecurityHistoryKind;
  /** ISO-8601 time the event was recorded. */
  occurredAt: string;
  /** Site the event was recorded under; null for instance-level events. */
  siteId: string | null;
  /**
   * Approximate client IP (IPv4 last octet / IPv6 beyond /48 masked). Null
   * when unknown or when the action was taken by someone else (an admin).
   */
  ipApprox: string | null;
  /** Raw User-Agent; null when unknown or when the action was taken by someone else. */
  userAgent: string | null;
  /** ISO-3166 alpha-2; null when GeoIP was unavailable. */
  countryCode: string | null;
  /** Small, allow-listed per-kind details (never secrets or token ids). */
  details: Record<string, string | number | boolean>;
}

/**
 * Approximate an IP for display: `203.0.113.7` → `203.0.113.x`,
 * `2001:db8:85a3:8d3:1319:8a2e:370:7348` → `2001:db8:85a3::/48`. Anything
 * that is not a recognisable address (or the sentinel `unknown`) → null.
 */
export function approximateIp(ip: string | null | undefined): string | null {
  if (typeof ip !== 'string') return null;
  const value = ip.trim();
  if (value.length === 0 || value === 'unknown') return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    if (octets.some((n) => n > 255)) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.x`;
  }
  if (value.includes(':') && /^[0-9a-f:.]+$/i.test(value)) {
    // IPv4-mapped IPv6 (`::ffff:203.0.113.7`) → treat as the IPv4 address.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
    if (mapped) return approximateIp(mapped[1]);
    const [head = ''] = value.split('::');
    const groups = head.split(':').filter((g) => g.length > 0).slice(0, 3);
    if (groups.length === 0) return null;
    return `${groups.map((g) => g.toLowerCase()).join(':')}::/48`;
  }
  return null;
}

/**
 * A short, human label for a User-Agent string ("Chrome on macOS"). Pure
 * heuristics — good enough to recognise your own devices, never used for
 * any security decision. Shared by the Studio session list / history and the
 * new-device sign-in email.
 */
export function describeUserAgent(ua: string | null | undefined): { label: string; mobile: boolean } {
  if (!ua) return { label: 'Unknown device', mobile: false };
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /Tauri|LumiBase-Shell/i.test(ua)
              ? 'LumiBase app'
              : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  const mobile = /Mobi|iPhone|Android/.test(ua);
  if (browser && os) return { label: `${browser} on ${os}`, mobile };
  if (browser || os) return { label: (browser ?? os)!, mobile };
  // Non-browser clients (SDK, curl): show the product token, trimmed.
  return { label: ua.split(/[\s/]/)[0]?.slice(0, 40) || 'Unknown device', mobile };
}
