import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  signVerificationToken,
  verifyVerificationToken,
} from '../email-verification';
import { TOKEN_AUDIENCE } from '../token-audience';

const SECRET = 'test-secret-do-not-use-in-prod';

describe('email-verification tokens', () => {
  it('round-trips a freshly signed token', async () => {
    const token = await signVerificationToken({ userId: 'u1', siteId: 's1' }, SECRET);
    const claims = await verifyVerificationToken(token, SECRET);
    expect(claims).toEqual({ userId: 'u1', siteId: 's1' });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signVerificationToken({ userId: 'u1', siteId: 's1' }, SECRET);
    expect(await verifyVerificationToken(token, 'other-secret')).toBeNull();
  });

  it('rejects a token carrying the wrong audience (e.g. a session token)', async () => {
    const key = new TextEncoder().encode(SECRET);
    const sessionToken = await new SignJWT({ siteId: 's1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setAudience(TOKEN_AUDIENCE.frontend) // NOT email-verify
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(key);
    expect(await verifyVerificationToken(sessionToken, SECRET)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const key = new TextEncoder().encode(SECRET);
    const expired = await new SignJWT({ siteId: 's1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setAudience(TOKEN_AUDIENCE.emailVerify)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
    expect(await verifyVerificationToken(expired, SECRET)).toBeNull();
  });

  it('rejects a token missing required claims', async () => {
    const key = new TextEncoder().encode(SECRET);
    const noSite = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u1')
      .setAudience(TOKEN_AUDIENCE.emailVerify)
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(key);
    expect(await verifyVerificationToken(noSite, SECRET)).toBeNull();
  });

  it('returns null for garbage input rather than throwing', async () => {
    expect(await verifyVerificationToken('not-a-jwt', SECRET)).toBeNull();
    expect(await verifyVerificationToken('', SECRET)).toBeNull();
  });
});
