/**
 * Publishable API keys.
 *
 * A publishable key is one an operator deliberately ships inside a browser
 * bundle or mobile app. It is NOT a secret and must never be treated as one:
 * anything in a client is extractable, so the only correct posture is to scope
 * it exactly as if it were already public.
 *
 * What it does buy, over serving the same data fully anonymously:
 *
 * - **quota attribution** — the general rate limiter already keys on
 *   `k:{apiKeyId}` (`middleware/rate-limit.ts`), so each client app gets its
 *   own bucket instead of sharing one IP bucket
 * - **revocation and rotation** without redeploying the CMS
 * - **audit** — `lastUsedAt`/`lastUsedIp` and the audit log attribute traffic
 * - **per-key scope** — staging vs production, or one app vs another, can hold
 *   different collections and field lists
 *
 * What it does not buy: confidentiality. If leaking the key would hurt, it is
 * the wrong mechanism — keep a secret key server-side and proxy through your
 * own backend.
 *
 * The `lbk_pub_` prefix makes the distinction greppable: a secret scanner can
 * alert on a leaked `lbk_` key and stay quiet about a `lbk_pub_` one, and an
 * operator reading an audit log can tell at a glance which kind was used.
 */

/** Prefix marking a token as client-embeddable. */
export const PUBLISHABLE_TOKEN_PREFIX = 'lbk_pub_';

/** `api_keys.metadata` key holding the per-key origin allowlist. */
export const ALLOWED_ORIGINS_METADATA_KEY = 'allowedOrigins';

/**
 * Whether a stored `api_keys.prefix` belongs to a publishable key.
 *
 * The prefix is derived from the token itself, so it cannot drift out of sync
 * with what the client actually holds — unlike a metadata flag, which a
 * partial write could leave inconsistent.
 */
export function isPublishablePrefix(prefix: string | null | undefined): boolean {
  return typeof prefix === 'string' && prefix.startsWith(PUBLISHABLE_TOKEN_PREFIX);
}

/** Read the origin allowlist out of an `api_keys.metadata` blob. */
export function readAllowedOrigins(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>)[ALLOWED_ORIGINS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map(normalizeOrigin)
    .filter((entry): entry is string => entry !== null);
}

/**
 * Normalise an origin to `scheme://host[:port]`, lowercased.
 *
 * Accepts a full URL so an operator can paste `https://example.com/` and get
 * the origin. Returns null for anything unparseable, which callers treat as
 * "not a usable allowlist entry" rather than as a wildcard.
 */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return null;
  }
}

export type OriginVerdict = 'allowed' | 'no_constraint' | 'absent' | 'denied';

/**
 * Decide whether a request's origin satisfies a publishable key's allowlist.
 *
 * Deliberate semantics, and the reason they are not stricter:
 *
 * - **empty allowlist → `no_constraint`.** The key works from anywhere. This is
 *   the default because native and server-side callers send no `Origin` at all.
 * - **origin present and matching → `allowed`.**
 * - **origin present and not matching → `denied`.** This is the case the
 *   control exists for: another website embedding your key in a browser. A
 *   browser sets `Origin` on cross-origin requests and script cannot forge it.
 * - **origin absent → `absent`,** which callers treat as allowed. Rejecting it
 *   would break legitimate non-browser callers while adding no security: a
 *   non-browser client can set any `Origin` value it likes, so an allowlist is
 *   never a defence against a determined caller — only against a browser
 *   running someone else's page.
 */
export function checkOrigin(
  origin: string | null | undefined,
  referer: string | null | undefined,
  allowed: string[],
): OriginVerdict {
  if (allowed.length === 0) return 'no_constraint';

  const candidate = normalizeOrigin(origin ?? '') ?? normalizeOrigin(referer ?? '');
  if (!candidate) return 'absent';

  return allowed.includes(candidate) ? 'allowed' : 'denied';
}

/**
 * Elevation flags a publishable key must never gain, given a policy row.
 *
 * A publishable key is public by construction, so `adminAccess` on it would be
 * an unauthenticated admin bypass with extra steps. `appAccess` is refused too:
 * an API key already cannot reach Studio (`withStudioAccess` requires a user
 * principal), so granting it only misleads whoever reads the policy later.
 *
 * Returns the offending flag names; empty means safe to attach.
 */
export function screenPolicyForPublishableKey(policy: {
  adminAccess?: boolean | null;
  appAccess?: boolean | null;
}): string[] {
  const violations: string[] = [];
  if (policy.adminAccess) violations.push('adminAccess');
  if (policy.appAccess) violations.push('appAccess');
  return violations;
}
