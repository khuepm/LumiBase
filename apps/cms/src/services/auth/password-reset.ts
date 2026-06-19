/**
 * Stateless password-reset tokens for self-service end-users.
 *
 * Mirrors {@link import('./email-verification')}: a short-lived HS256 JWT
 * (signed with `JWT_SECRET`) carrying the user id + site and a dedicated
 * `password-reset` audience so the link can never double as a session or
 * verification token. `POST /auth/forgot-password` mints it (emailed
 * inside the link); `POST /auth/reset-password` verifies it and sets the
 * new password hash.
 *
 * Stateless trade-off (same as verification, see ADR-010): no per-token
 * revocation and a reset token stays valid until expiry. We keep the TTL
 * short (1h). Single-use is best-effort — the token is consumed once the
 * password changes, but a replay within the window would re-set the same
 * (already-changed) password; acceptable for a 1h link. A future
 * `users.passwordChangedAt` column could harden this if needed.
 */

import { SignJWT, jwtVerify } from 'jose';
import { TOKEN_AUDIENCE } from './token-audience';

/** Validity window for a reset link. Deliberately shorter than verify. */
const RESET_TOKEN_TTL = '1h';

export interface PasswordResetClaims {
  /** Internal `users.id` whose password is being reset. */
  userId: string;
  /** Site the reset belongs to (must match the request tenant). */
  siteId: string;
}

export async function signPasswordResetToken(
  claims: PasswordResetClaims,
  secret: string,
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ siteId: claims.siteId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setAudience(TOKEN_AUDIENCE.passwordReset)
    .setIssuedAt()
    .setExpirationTime(RESET_TOKEN_TTL)
    .sign(key);
}

/**
 * Verify a reset token. Returns the claims on success or `null` when the
 * token is invalid, expired, has the wrong audience, or is missing
 * required fields. Never throws.
 */
export async function verifyPasswordResetToken(
  token: string,
  secret: string,
): Promise<PasswordResetClaims | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      audience: TOKEN_AUDIENCE.passwordReset,
    });
    const userId = typeof payload.sub === 'string' ? payload.sub : null;
    const siteId = typeof payload.siteId === 'string' ? payload.siteId : null;
    if (!userId || !siteId) return null;
    return { userId, siteId };
  } catch {
    return null;
  }
}
