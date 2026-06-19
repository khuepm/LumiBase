/**
 * Custom-JWT audiences (the `aud` claim).
 *
 * LumiBase issues HS256 Custom JWTs from `POST /auth/login` for two very
 * different realms that happen to share one endpoint and one signing
 * secret:
 *
 *   - `studio`   — staff/teammates whose role grants `appAccess` (or the
 *                  bootstrap admin). These tokens are allowed to reach the
 *                  Studio management surface.
 *   - `frontend` — self-service end-users (subscribers) of the public
 *                  Next.js site. These tokens are ONLY for content APIs.
 *
 * Pinning an `aud` at sign time lets `withStudioAccess` reject a
 * `frontend` token outright — a hard wall that does not depend on the
 * (separately-enforced) `appAccess` policy bundle. Defense-in-depth: even
 * if a future role misconfiguration granted a subscriber `appAccess`,
 * their token still cannot be replayed against Studio because the
 * audience says "frontend".
 *
 * A third audience, `email-verify`, tags the short-lived stateless token
 * embedded in the registration verification email. It is deliberately
 * NOT one of the login audiences so a verification link can never be used
 * as a session token (and vice versa).
 *
 * See `docs/en/architecture/decisions/0001-user-management-realms.md`.
 */

export const TOKEN_AUDIENCE = {
  /** Staff/teammates allowed into the Studio management surface. */
  studio: 'studio',
  /** Self-service frontend end-users; content APIs only. */
  frontend: 'frontend',
  /** Single-purpose email-verification link token (not a session token). */
  emailVerify: 'email-verify',
  /** Single-purpose password-reset link token (not a session token). */
  passwordReset: 'password-reset',
} as const;

export type TokenAudience = (typeof TOKEN_AUDIENCE)[keyof typeof TOKEN_AUDIENCE];

/**
 * Normalize the `aud` claim (jose may surface it as a string or an array)
 * into a flat list for comparison.
 */
export function audienceValues(aud: unknown): string[] {
  if (typeof aud === 'string') return [aud];
  if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === 'string');
  return [];
}

/** True when the token carries the `frontend` (subscriber) audience. */
export function isFrontendAudience(aud: unknown): boolean {
  return audienceValues(aud).includes(TOKEN_AUDIENCE.frontend);
}

/**
 * Per-realm session-token lifetimes. The two realms have different risk and
 * UX profiles, so they no longer share one TTL:
 *
 *   - `studio` (staff/CMS) — short by default; a stolen staff token is the
 *     higher-value target, and staff re-auth within a working day is cheap.
 *   - `frontend` (subscribers) — long by default; forcing visitors to log
 *     in daily is bad UX and brings little security benefit.
 *
 * Operators override via `STUDIO_SESSION_TTL` / `FRONTEND_SESSION_TTL`.
 * These are plain session TTLs (no refresh token yet), so the value is the
 * forced re-login interval.
 */
export const DEFAULT_SESSION_TTL = {
  studio: '12h',
  frontend: '30d',
} as const;

/** Accepts `<number>` (seconds) or `<number><unit>` where unit ∈ s/m/h/d/w/y. */
const TTL_PATTERN = /^\d+(\.\d+)?\s*(s|m|h|d|w|y)?$/i;

/**
 * Resolve the session TTL string (for `jose`'s `setExpirationTime`) for a
 * given login audience, honouring the env overrides. An absent or
 * malformed override falls back to the realm default so a typo in the
 * environment can never break login.
 */
export function sessionTtlFor(
  audience: string,
  env?: { STUDIO_SESSION_TTL?: string; FRONTEND_SESSION_TTL?: string },
): string {
  const isFrontend = audience === TOKEN_AUDIENCE.frontend;
  const fallback = isFrontend ? DEFAULT_SESSION_TTL.frontend : DEFAULT_SESSION_TTL.studio;
  const raw = (isFrontend ? env?.FRONTEND_SESSION_TTL : env?.STUDIO_SESSION_TTL)?.trim();
  if (!raw || !TTL_PATTERN.test(raw)) return fallback;
  return raw;
}
