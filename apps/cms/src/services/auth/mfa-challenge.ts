/**
 * Short-lived MFA challenge tokens issued after password verification.
 * Distinct audience from session JWTs — cannot be replayed as a session.
 */

import { SignJWT, jwtVerify } from 'jose';
import { TOKEN_AUDIENCE } from './token-audience';

const CHALLENGE_TTL = '5m';

export interface MfaChallengeClaims {
  userId: string;
  siteId: string;
  jti: string;
  loginAudience: string;
}

export async function signMfaChallengeToken(
  claims: Omit<MfaChallengeClaims, 'jti'> & { jti?: string },
  secret: string,
): Promise<{ token: string; jti: string; expiresInSeconds: number }> {
  const jti = claims.jti ?? crypto.randomUUID();
  const key = new TextEncoder().encode(secret);
  const token = await new SignJWT({
    siteId: claims.siteId,
    jti,
    loginAudience: claims.loginAudience,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setAudience(TOKEN_AUDIENCE.mfaChallenge)
    .setIssuedAt()
    .setExpirationTime(CHALLENGE_TTL)
    .sign(key);
  return { token, jti, expiresInSeconds: 5 * 60 };
}

export async function verifyMfaChallengeToken(
  token: string,
  secret: string,
): Promise<MfaChallengeClaims | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      audience: TOKEN_AUDIENCE.mfaChallenge,
    });
    const userId = typeof payload.sub === 'string' ? payload.sub : null;
    const siteId = typeof payload.siteId === 'string' ? payload.siteId : null;
    const jti = typeof payload.jti === 'string' ? payload.jti : null;
    const loginAudience = typeof payload.loginAudience === 'string' ? payload.loginAudience : null;
    if (!userId || !siteId || !jti || !loginAudience) return null;
    return { userId, siteId, jti, loginAudience };
  } catch {
    return null;
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
