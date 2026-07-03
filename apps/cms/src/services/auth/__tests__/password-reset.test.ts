import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  signPasswordResetToken,
  verifyPasswordResetToken,
  isResetTokenStale,
} from '../password-reset';
import { TOKEN_AUDIENCE } from '../token-audience';

const SECRET = 'test-secret-do-not-use-in-prod';

describe('password-reset tokens', () => {
  it('round-trips a freshly signed token, exposing issuedAt for single-use checks', async () => {
    const token = await signPasswordResetToken({ userId: 'u1', siteId: 's1' }, SECRET);
    const claims = await verifyPasswordResetToken(token, SECRET);
    expect(claims).toMatchObject({ userId: 'u1', siteId: 's1' });
    expect(typeof claims?.issuedAt).toBe('number');
  });

  it('rejects a different secret', async () => {
    const token = await signPasswordResetToken({ userId: 'u1', siteId: 's1' }, SECRET);
    expect(await verifyPasswordResetToken(token, 'other')).toBeNull();
  });

  it('rejects a token with a non-reset audience (e.g. a session or verify token)', async () => {
    const key = new TextEncoder().encode(SECRET);
    for (const aud of [TOKEN_AUDIENCE.frontend, TOKEN_AUDIENCE.emailVerify, TOKEN_AUDIENCE.studio]) {
      const t = await new SignJWT({ siteId: 's1' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('u1')
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key);
      expect(await verifyPasswordResetToken(t, SECRET)).toBeNull();
    }
  });

  it('rejects an expired token', async () => {
    const key = new TextEncoder().encode(SECRET);
    const expired = await new SignJWT({ siteId: 's1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setAudience(TOKEN_AUDIENCE.passwordReset)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
    expect(await verifyPasswordResetToken(expired, SECRET)).toBeNull();
  });

  it('returns null for garbage rather than throwing', async () => {
    expect(await verifyPasswordResetToken('nope', SECRET)).toBeNull();
  });
});

describe('isResetTokenStale (single-use guard, H1)', () => {
  const iatSeconds = 1_000_000; // token issued at t = 1_000_000s

  it('is not stale when the account never changed its password', () => {
    expect(isResetTokenStale(iatSeconds, null)).toBe(false);
    expect(isResetTokenStale(iatSeconds, undefined)).toBe(false);
  });

  it('is not stale when the last change predates the token', () => {
    // password last changed one second BEFORE the token was issued
    expect(isResetTokenStale(iatSeconds, new Date((iatSeconds - 1) * 1000))).toBe(false);
  });

  it('is stale once the password changed at/after the token was issued (replay + supersession)', () => {
    // consumed: passwordChangedAt is set just after issue → replay rejected
    expect(isResetTokenStale(iatSeconds, new Date(iatSeconds * 1000 + 500))).toBe(true);
    // a newer reset/change fully after issue → this older link rejected
    expect(isResetTokenStale(iatSeconds, new Date((iatSeconds + 3600) * 1000))).toBe(true);
  });
});
