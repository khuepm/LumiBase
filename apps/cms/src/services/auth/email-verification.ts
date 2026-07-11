/**
 * Stateless email-verification tokens for self-service registration.
 *
 * Rather than persist a verification token table, we sign a short-lived
 * HS256 JWT (with the shared `JWT_SECRET`) carrying just enough to
 * activate the account: the user id, the site it was registered for, and
 * a dedicated `email-verify` audience so the token can never double as a
 * session token. The link in the verification email embeds this token;
 * `POST /auth/verify-email` verifies the signature + expiry and flips the
 * user from `invited` → `active`.
 *
 * Why stateless (no DB row):
 *   - Edge-native: works identically on Cloudflare Workers and Docker
 *     with zero extra storage round-trips (Strict Rule #3 spirit).
 *   - Single-use is enforced by the *state transition*, not the token:
 *     once the user is `active`, re-presenting the same token is an
 *     idempotent no-op (`already-verified`), and the token expires on its
 *     own. There is no spendable secret left in the DB to leak.
 *   - Revocation granularity (per-token) is intentionally traded away;
 *     for a 24h verification link that is an acceptable trade. Rotating
 *     `JWT_SECRET` invalidates all outstanding links if ever needed.
 *
 * See `docs/en/architecture/decisions/0001-user-management-realms.md`.
 */

import { SignJWT, jwtVerify } from 'jose';
import { TOKEN_AUDIENCE } from './token-audience';

/** Validity window for a verification link. */
const VERIFY_TOKEN_TTL = '24h';

export interface VerificationClaims {
  /** Internal `users.id` to activate. */
  userId: string;
  /** Site the registration belongs to (must match the request tenant). */
  siteId: string;
}

/**
 * Sign a verification token for the given user/site. The raw token is
 * embedded in the email link and never persisted server-side.
 */
export async function signVerificationToken(
  claims: VerificationClaims,
  secret: string,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ siteId: claims.siteId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setAudience(TOKEN_AUDIENCE.emailVerify)
    .setIssuedAt()
    .setExpirationTime(VERIFY_TOKEN_TTL)
    .sign(key);
}

/**
 * Verify a verification token. Returns the claims on success or `null`
 * when the token is invalid, expired, carries the wrong audience, or is
 * missing required fields. Never throws — the caller maps `null` to a
 * generic `INVALID_TOKEN` response (no enumeration of why it failed).
 */
export async function verifyVerificationToken(
  token: string,
  secret: string,
): Promise<VerificationClaims | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      audience: TOKEN_AUDIENCE.emailVerify,
    });
    const userId = typeof payload.sub === 'string' ? payload.sub : null;
    const siteId = typeof payload.siteId === 'string' ? payload.siteId : null;
    if (!userId || !siteId) return null;
    return { userId, siteId };
  } catch {
    return null;
  }
}
