import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  signPasswordResetToken,
  verifyPasswordResetToken,
} from '../password-reset';
import { TOKEN_AUDIENCE } from '../token-audience';

const SECRET = 'test-secret-do-not-use-in-prod';

describe('password-reset tokens', () => {
  it('round-trips a freshly signed token', async () => {
    const token = await signPasswordResetToken({ userId: 'u1', siteId: 's1' }, SECRET);
    expect(await verifyPasswordResetToken(token, SECRET)).toEqual({ userId: 'u1', siteId: 's1' });
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
