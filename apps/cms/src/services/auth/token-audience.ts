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
