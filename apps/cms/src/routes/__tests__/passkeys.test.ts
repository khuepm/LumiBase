import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { decodeJwt } from 'jose';
import { MemoryCacheProvider, type CacheProvider } from '@lumibase/runtime';
import { roles, userPasskeys, userSites, userTotpRecoveryCodes, users, type Database } from '@lumibase/database';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { AppEnv, AuthPrincipal } from '../../env';
import { createMiniDb, type MiniDb } from '../../test-utils/mini-drizzle-db';
import { hashPassword } from '../../services/auth/password';
import { signMfaChallengeToken } from '../../services/auth/mfa-challenge';
import { TOKEN_AUDIENCE } from '../../services/auth/token-audience';
import { isSessionTfaVerified, isTfaEnrolled } from '../../middleware/studio-access';

/**
 * #735 routes end to end over an in-memory DB: real option generation, real
 * ceremony cache, real JWT minting through `completePasswordLoginSession`;
 * only the authenticator signature checks, the refresh-token insert, the
 * login-guard bookkeeping and the audit sink are stubbed.
 */

const stub = vi.hoisted(() => ({
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  recordLoginSuccess: vi.fn(),
  revokeOtherSessions: vi.fn(),
  revokeAllRefreshTokens: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...actual,
    verifyRegistrationResponse: stub.verifyRegistrationResponse,
    verifyAuthenticationResponse: stub.verifyAuthenticationResponse,
  };
});
vi.mock('../../modules/login-guard/hooks', () => ({ recordLoginSuccess: stub.recordLoginSuccess }));
vi.mock('../../services/auth/refresh-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/refresh-token')>();
  return {
    ...actual,
    issueRefreshToken: async () => ({ token: 'refresh-token', expiresAt: new Date(Date.now() + 60_000) }),
    revokeOtherSessions: stub.revokeOtherSessions,
    revokeAllRefreshTokens: stub.revokeAllRefreshTokens,
  };
});
vi.mock('../../modules/audit/logger', () => ({
  AuditLogger: class {
    write(entry: unknown) {
      stub.audit(entry);
      return Promise.resolve();
    }
  },
}));

const { passkeyAuthRouter, passkeyMeRouter } = await import('../passkeys');

const JWT_SECRET = 'test-secret-for-passkeys-0123456789';
const ORIGIN = 'https://studio.example.com';
const ENV = { JWT_SECRET, WEBAUTHN_ORIGINS: ORIGIN, LUMIBASE_ENV: 'production' };
const PASSWORD = 'Correct-Horse-9';

let mini: MiniDb;
let cache: CacheProvider;

function buildApp(auth?: Partial<AuthPrincipal>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', mini.db as Database);
    c.set('systemDb', mini.db as Database);
    c.set('siteId', 'site-a');
    c.set('requestId', 'req-1');
    c.set('runtime', { cache } as never);
    if (auth) c.set('auth', { roles: ['member'], raw: {}, ...auth } as never);
    await next();
  });
  app.route('/api/v1/auth', passkeyAuthRouter);
  app.route('/api/v1/me', passkeyMeRouter);
  return app;
}

const post = (app: Hono<AppEnv>, path: string, body: unknown, method = 'POST', env: Record<string, string> = ENV) =>
  app.request(
    path,
    { method, headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) },
    env,
  );

const assertion = (id: string): AuthenticationResponseJSON => ({
  id,
  rawId: id,
  type: 'public-key',
  response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z' },
  clientExtensionResults: {},
});

const verified = (newCounter: number) => ({
  verified: true,
  authenticationInfo: {
    credentialID: 'x',
    newCounter,
    userVerified: true,
    credentialDeviceType: 'multiDevice',
    credentialBackedUp: true,
    origin: ORIGIN,
    rpID: 'studio.example.com',
  },
});

beforeEach(async () => {
  for (const fn of Object.values(stub)) fn.mockReset();
  stub.revokeOtherSessions.mockResolvedValue(2);
  mini = createMiniDb();
  cache = new MemoryCacheProvider();
  mini.seed(users, [
    { id: 'usr_staff', email: 'staff@example.test', status: 'active', tfa: {}, tokenVersion: 3, isBootstrap: false, passwordHash: await hashPassword(PASSWORD) },
    { id: 'usr_sub', email: 'sub@example.test', status: 'active', tfa: {}, tokenVersion: 0, isBootstrap: false },
  ]);
  mini.seed(roles, [
    { id: 'role_editor', siteId: 'site-a', appAccess: true },
    { id: 'role_subscriber', siteId: 'site-a', appAccess: false },
  ]);
  mini.seed(userSites, [
    { userId: 'usr_staff', siteId: 'site-a', roleId: 'role_editor' },
    { userId: 'usr_sub', siteId: 'site-a', roleId: 'role_subscriber' },
  ]);
  mini.seed(userPasskeys, [
    { userId: 'usr_staff', credentialId: 'staff-cred', publicKey: 'AQID', counter: 5, name: 'Mac', rpId: 'studio.example.com' },
    { userId: 'usr_sub', credentialId: 'sub-cred', publicKey: 'AQID', counter: 0, name: 'Phone', rpId: 'studio.example.com' },
  ]);
});

async function challengeFor(userId: string, siteId = 'site-a') {
  return (await signMfaChallengeToken({ userId, siteId, loginAudience: TOKEN_AUDIENCE.studio }, JWT_SECRET)).token;
}

describe('passkey as second factor', () => {
  it('mints a TFA-verified session (amr pwd+webauthn, sid) that satisfies enforceTfa', async () => {
    const app = buildApp();
    const challengeToken = await challengeFor('usr_staff');
    const opts = await post(app, '/api/v1/auth/passkey/options', { challengeToken });
    expect(opts.status).toBe(200);
    const { data } = await opts.json() as { data: { ceremonyId: string; options: { allowCredentials: { id: string }[]; rpId: string } } };
    expect(data.options.rpId).toBe('studio.example.com');
    expect(data.options.allowCredentials.map((c) => c.id)).toEqual(['staff-cred']);

    stub.verifyAuthenticationResponse.mockResolvedValue(verified(6));
    const res = await post(app, '/api/v1/auth/passkey/verify', {
      challengeToken,
      ceremonyId: data.ceremonyId,
      response: assertion('staff-cred'),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { token: string; refreshToken: string } };
    const claims = decodeJwt(body.data.token);
    expect(claims).toMatchObject({ userId: 'usr_staff', siteId: 'site-a', tfaVerified: true, amr: ['pwd', 'webauthn'], tokenVersion: 3 });
    expect(typeof claims.sid).toBe('string');
    expect(claims.aud).toBe(TOKEN_AUDIENCE.studio);
    expect(isSessionTfaVerified({ raw: claims } as AuthPrincipal)).toBe(true);
    expect(stub.recordLoginSuccess).toHaveBeenCalledTimes(1);
    expect(mini.rows(userPasskeys).find((p) => p.credentialId === 'staff-cred')!.counter).toBe(6);
  });

  it('spends the challenge token: a second ceremony with the same token is refused', async () => {
    const app = buildApp();
    const challengeToken = await challengeFor('usr_staff');
    stub.verifyAuthenticationResponse.mockResolvedValue(verified(6));
    for (const expected of [200, 401]) {
      const { data } = await (await post(app, '/api/v1/auth/passkey/options', { challengeToken })).json() as { data: { ceremonyId: string } };
      const res = await post(app, '/api/v1/auth/passkey/verify', { challengeToken, ceremonyId: data.ceremonyId, response: assertion('staff-cred') });
      expect(res.status).toBe(expected);
    }
  });

  it('refuses a challenge token minted for another site', async () => {
    const res = await post(buildApp(), '/api/v1/auth/passkey/options', { challengeToken: await challengeFor('usr_staff', 'site-b') });
    expect(res.status).toBe(401);
  });

  it('refuses another user’s passkey and audits the failure', async () => {
    const app = buildApp();
    const challengeToken = await challengeFor('usr_staff');
    const { data } = await (await post(app, '/api/v1/auth/passkey/options', { challengeToken })).json() as { data: { ceremonyId: string } };
    const res = await post(app, '/api/v1/auth/passkey/verify', { challengeToken, ceremonyId: data.ceremonyId, response: assertion('sub-cred') });
    expect(res.status).toBe(401);
    expect(stub.audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'mfa_verify_failed' }));
    expect(stub.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('rejects a counter regression and writes passkey_counter_regression', async () => {
    const app = buildApp();
    const challengeToken = await challengeFor('usr_staff');
    const { data } = await (await post(app, '/api/v1/auth/passkey/options', { challengeToken })).json() as { data: { ceremonyId: string } };
    stub.verifyAuthenticationResponse.mockResolvedValue(verified(5));
    const res = await post(app, '/api/v1/auth/passkey/verify', { challengeToken, ceremonyId: data.ceremonyId, response: assertion('staff-cred') });
    expect(res.status).toBe(401);
    expect(stub.audit).toHaveBeenCalledWith(expect.objectContaining({
      event: 'passkey_counter_regression',
      metadata: expect.objectContaining({ userId: 'usr_staff', storedCounter: 5, receivedCounter: 5 }),
    }));
    expect(stub.recordLoginSuccess).not.toHaveBeenCalled();
  });
});

describe('passwordless staff sign-in', () => {
  async function signIn(app: Hono<AppEnv>, credentialId: string) {
    const { data } = await (await post(app, '/api/v1/auth/passkey/options', {})).json() as { data: { ceremonyId: string; options: { userVerification: string } } };
    expect(data.options.userVerification).toBe('required');
    return { ceremonyId: data.ceremonyId, res: await post(app, '/api/v1/auth/passkey/verify', { ceremonyId: data.ceremonyId, response: assertion(credentialId) }) };
  }

  it('signs a staff member in with amr webauthn and tfaVerified', async () => {
    stub.verifyAuthenticationResponse.mockResolvedValue(verified(9));
    const { res } = await signIn(buildApp(), 'staff-cred');
    expect(res.status).toBe(200);
    const claims = decodeJwt((await res.json() as { data: { token: string } }).data.token);
    expect(claims).toMatchObject({ userId: 'usr_staff', roles: ['role_editor'], tfaVerified: true, amr: ['webauthn'] });
    expect(typeof claims.sid).toBe('string');
    expect(stub.verifyAuthenticationResponse.mock.calls[0]![0].requireUserVerification).toBe(true);
  });

  it('refuses a subscriber (frontend realm)', async () => {
    stub.verifyAuthenticationResponse.mockResolvedValue(verified(1));
    const { res } = await signIn(buildApp(), 'sub-cred');
    expect(res.status).toBe(403);
    expect((await res.json() as { errors: { code: string }[] }).errors[0]!.code).toBe('PASSKEY_STUDIO_ONLY');
  });

  it('refuses a locked account', async () => {
    mini.rows(users).find((u) => u.id === 'usr_staff')!.lockedUntil = new Date(Date.now() + 60_000);
    stub.verifyAuthenticationResponse.mockResolvedValue(verified(9));
    expect((await signIn(buildApp(), 'staff-cred')).res.status).toBe(423);
  });

  it('a ceremony cannot be replayed', async () => {
    const app = buildApp();
    stub.verifyAuthenticationResponse.mockResolvedValue(verified(9));
    const { ceremonyId, res } = await signIn(app, 'staff-cred');
    expect(res.status).toBe(200);
    stub.verifyAuthenticationResponse.mockResolvedValue(verified(10));
    const replay = await post(app, '/api/v1/auth/passkey/verify', { ceremonyId, response: assertion('staff-cred') });
    expect(replay.status).toBe(401);
  });

  it('answers 503 when no trusted origin / RP ID can be resolved', async () => {
    const res = await post(buildApp(), '/api/v1/auth/passkey/options', {}, 'POST', { JWT_SECRET, LUMIBASE_ENV: 'production' });
    expect(res.status).toBe(503);
    expect((await res.json() as { errors: { code: string }[] }).errors[0]!.code).toBe('WEBAUTHN_NOT_CONFIGURED');
  });
});

describe('/me/passkeys', () => {
  const staff = { userId: 'usr_staff', email: 'staff@example.test', raw: { sid: 'fam-1' } };

  beforeEach(() => {
    // Start from a staff user without any factor.
    const rows = mini.rows(userPasskeys);
    rows.splice(0, rows.length);
  });

  it('registration requires the password', async () => {
    const res = await post(buildApp(staff), '/api/v1/me/passkeys/registration-options', { password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('registers a first passkey: recovery codes, enrolled flag, other sessions revoked', async () => {
    const app = buildApp(staff);
    const opts = await post(app, '/api/v1/me/passkeys/registration-options', { password: PASSWORD });
    expect(opts.status).toBe(200);
    const { data } = await opts.json() as { data: { ceremonyId: string; options: { rp: { id: string } } } };
    expect(data.options.rp.id).toBe('studio.example.com');

    stub.verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        aaguid: '00000000-0000-0000-0000-000000000000',
        credential: { id: 'new-cred', publicKey: new Uint8Array([1]), counter: 0, transports: ['internal'] },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    });
    const res = await post(app, '/api/v1/me/passkeys', {
      ceremonyId: data.ceremonyId,
      name: 'Work laptop',
      response: { id: 'new-cred', rawId: 'new-cred', type: 'public-key', response: { clientDataJSON: 'a', attestationObject: 'b' } },
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { passkey: { name: string }; recoveryCodes: string[] } };
    expect(body.data.passkey.name).toBe('Work laptop');
    expect(body.data.recoveryCodes).toHaveLength(8);
    expect(isTfaEnrolled(mini.rows(users).find((u) => u.id === 'usr_staff')!.tfa)).toBe(true);
    expect(stub.revokeOtherSessions).toHaveBeenCalledWith(expect.anything(), 'site-a', 'usr_staff', 'fam-1');
    expect(stub.audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'passkey_registered' }));

    const list = await (await buildApp(staff).request('/api/v1/me/passkeys', {}, ENV)).json() as {
      data: { passkeys: { name: string }[]; recoveryCodesRemaining: number; available: boolean };
    };
    expect(list.data.passkeys.map((p) => p.name)).toEqual(['Work laptop']);
    expect(list.data.recoveryCodesRemaining).toBe(8);
  });

  it('renames only the caller’s own passkey', async () => {
    mini.seed(userPasskeys, [{ id: 'pk_other', userId: 'usr_sub', credentialId: 'c', publicKey: 'p', name: 'X', rpId: 'studio.example.com' }]);
    const res = await post(buildApp(staff), '/api/v1/me/passkeys/pk_other', { name: 'Mine now' }, 'PATCH');
    expect(res.status).toBe(404);
    expect(mini.rows(userPasskeys)[0]!.name).toBe('X');
  });

  it('removing the last factor signs every session out', async () => {
    mini.seed(userPasskeys, [{ id: 'pk_1', userId: 'usr_staff', credentialId: 'c1', publicKey: 'p', name: 'Mac', rpId: 'studio.example.com' }]);
    mini.seed(userTotpRecoveryCodes, [{ userId: 'usr_staff', codeHash: 'h' }]);
    const res = await post(buildApp(staff), '/api/v1/me/passkeys/pk_1', { password: PASSWORD }, 'DELETE');
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { signedOut: boolean } }).data.signedOut).toBe(true);
    expect(mini.rows(users).find((u) => u.id === 'usr_staff')!.tokenVersion).toBe(4);
    expect(stub.revokeAllRefreshTokens).toHaveBeenCalledWith(expect.anything(), 'site-a', 'usr_staff');
    expect(mini.rows(userTotpRecoveryCodes)).toHaveLength(0);
  });

  it('recovery-code regeneration needs a passkey-verified session', async () => {
    mini.seed(userPasskeys, [{ id: 'pk_1', userId: 'usr_staff', credentialId: 'c1', publicKey: 'p', name: 'Mac', rpId: 'studio.example.com' }]);
    const denied = await post(buildApp({ ...staff, raw: { amr: ['pwd'] } }), '/api/v1/me/passkeys/recovery-codes', { password: PASSWORD });
    expect(denied.status).toBe(403);
    const ok = await post(buildApp({ ...staff, raw: { amr: ['webauthn'] } }), '/api/v1/me/passkeys/recovery-codes', { password: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { data: { recoveryCodes: string[] } }).data.recoveryCodes).toHaveLength(8);
  });
});
