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
  /**
   * Issued-at (seconds since epoch). The consumer rejects the token when
   * this predates `users.password_changed_at`, making the token single-use:
   * once the password changes, this and every earlier link are stale.
   */
  issuedAt: number;
}

export async function signPasswordResetToken(
  claims: Omit<PasswordResetClaims, 'issuedAt'>,
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
 * Single-use guard (H1): a reset token is stale when it was issued before
 * the account's last password change. Consuming a reset (or a self-service
 * change) stamps `users.password_changed_at`, so a replayed link — or any
 * older outstanding link — fails this check. `issuedAt` is the JWT `iat`
 * (whole seconds); a null `passwordChangedAt` (never changed) is never stale.
 */
export function isResetTokenStale(
  issuedAtSeconds: number,
  passwordChangedAt: Date | null | undefined,
): boolean {
  if (!passwordChangedAt) return false;
  return issuedAtSeconds * 1000 < passwordChangedAt.getTime();
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
    const issuedAt = typeof payload.iat === 'number' ? payload.iat : null;
    if (!userId || !siteId || issuedAt === null) return null;
    return { userId, siteId, issuedAt };
  } catch {
    return null;
  }
}
