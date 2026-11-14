/**
 * Redirect-URI allow-list (#736). The frontend names where the browser should
 * land after the provider round-trip; the CMS only ever redirects to a URI the
 * site operator registered for that provider, compared EXACTLY (scheme, host,
 * port, path and query — no prefixes, no wildcards). This is what prevents the
 * callback from being used as an open redirect or to hand our one-time code to
 * an attacker-chosen origin.
 */

const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate one allow-list entry at configuration time. Returns the normalised
 * URI or an error string. Allowed: `https://…`, `http://` only on loopback
 * (local development), and a custom scheme (`myapp://callback`) for native
 * apps. Never a fragment, credentials, or a wildcard.
 */
export function validateRedirectUri(raw: unknown): { ok: true; uri: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'must be a non-empty string' };
  const value = raw.trim();
  if (value.includes('*')) return { ok: false, reason: 'wildcards are not allowed' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'must be an absolute URI' };
  }
  if (FORBIDDEN_SCHEMES.has(url.protocol)) return { ok: false, reason: `scheme ${url.protocol} is not allowed` };
  if (url.hash) return { ok: false, reason: 'must not contain a fragment' };
  if (url.username || url.password) return { ok: false, reason: 'must not contain credentials' };
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, reason: 'http is only allowed for localhost; use https' };
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) {
    return { ok: false, reason: 'must have a host' };
  }
  return { ok: true, uri: url.href };
}

/** True when `candidate` is exactly one of the (validated) allow-list entries. */
export function isAllowedRedirect(candidate: unknown, allowList: readonly string[]): boolean {
  const parsed = validateRedirectUri(candidate);
  if (!parsed.ok) return false;
  return allowList.some((entry) => {
    const allowed = validateRedirectUri(entry);
    return allowed.ok && allowed.uri === parsed.uri;
  });
}

/** Append our result params to an allow-listed redirect URI (keeps its own query). */
export function withResultParams(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  return url.href;
}
