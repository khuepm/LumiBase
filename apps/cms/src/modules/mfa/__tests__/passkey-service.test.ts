import { beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { MemoryCacheProvider, type CacheProvider } from '@lumibase/runtime';
import {
  userPasskeys,
  userTotpCredentials,
  userTotpRecoveryCodes,
  users,
  type Database,
} from '@lumibase/database';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { createMiniDb, type MiniDb } from '../../../test-utils/mini-drizzle-db';
import type { WebAuthnRp } from '../webauthn-config';

/**
 * Passkey ceremonies (#735). Option generation is the real
 * `@simplewebauthn/server` code; only the two cryptographic `verify*` calls are
 * mocked, since producing a genuine authenticator signature needs a browser.
 */

const lib = vi.hoisted(() => ({
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...actual,
    verifyRegistrationResponse: lib.verifyRegistrationResponse,
    verifyAuthenticationResponse: lib.verifyAuthenticationResponse,
  };
});

const svc = await import('../passkey-service');
const { disableUserTotp } = await import('../totp-service');

const RP: WebAuthnRp = { rpId: 'studio.example.com', rpName: 'LumiBase', origins: ['https://studio.example.com'] };

let mini: MiniDb;
let db: Database;
let cache: CacheProvider;

const regResponse = (id = 'cred-1'): RegistrationResponseJSON => ({
  id,
  rawId: id,
  type: 'public-key',
  response: { clientDataJSON: 'x', attestationObject: 'y' },
  clientExtensionResults: {},
});

const authResponse = (id: string, userHandle?: string): AuthenticationResponseJSON => ({
  id,
  rawId: id,
  type: 'public-key',
  response: { clientDataJSON: 'x', authenticatorData: 'y', signature: 'z', ...(userHandle ? { userHandle } : {}) },
  clientExtensionResults: {},
});

function verifiedRegistration(credentialId: string, counter = 0) {
  return {
    verified: true,
    registrationInfo: {
      fmt: 'none',
      aaguid: '00000000-0000-0000-0000-000000000000',
      credential: {
        id: credentialId,
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter,
        transports: ['internal', 'hybrid'],
      },
      credentialType: 'public-key',
      attestationObject: new Uint8Array(),
      userVerified: true,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      origin: RP.origins[0],
      rpID: RP.rpId,
    },
  };
}

function verifiedAssertion(newCounter: number) {
  return {
    verified: true,
    authenticationInfo: {
      credentialID: 'ignored',
      newCounter,
      userVerified: true,
      credentialDeviceType: 'multiDevice',
      credentialBackedUp: true,
      origin: RP.origins[0],
      rpID: RP.rpId,
    },
  };
}

async function register(userId: string, credentialId: string) {
  const { ceremonyId } = await svc.beginPasskeyRegistration(db, cache, {
    userId,
    userName: `${userId}@example.test`,
    displayName: userId,
    rp: RP,
  });
  lib.verifyRegistrationResponse.mockResolvedValueOnce(verifiedRegistration(credentialId));
  return svc.finishPasskeyRegistration(db, cache, { userId, ceremonyId, response: regResponse(credentialId) });
}

function seedPasskey(row: Partial<typeof userPasskeys.$inferInsert> & { userId: string; credentialId: string }) {
  mini.seed(userPasskeys, [{
    publicKey: isoBase64URL.fromBuffer(new Uint8Array([9, 9])),
    counter: 0,
    name: 'Key',
    rpId: RP.rpId,
    backedUp: false,
    ...row,
  }]);
}

beforeEach(() => {
  lib.verifyRegistrationResponse.mockReset();
  lib.verifyAuthenticationResponse.mockReset();
  mini = createMiniDb();
  db = mini.db as Database;
  cache = new MemoryCacheProvider();
  mini.seed(users, [
    { id: 'usr_a', email: 'a@example.test', tfa: {}, tokenVersion: 0, status: 'active' },
    { id: 'usr_b', email: 'b@example.test', tfa: {}, tokenVersion: 0, status: 'active' },
  ]);
});

describe('registration', () => {
  it('generates real creation options bound to the RP and the user id', async () => {
    seedPasskey({ userId: 'usr_a', credentialId: 'existing-cred', transports: ['usb'] });
    const { ceremonyId, options } = await svc.beginPasskeyRegistration(db, cache, {
      userId: 'usr_a',
      userName: 'a@example.test',
      displayName: 'Ada',
      rp: RP,
    });
    expect(ceremonyId.length).toBeGreaterThanOrEqual(16);
    expect(options.rp).toEqual({ id: RP.rpId, name: RP.rpName });
    expect(new TextDecoder().decode(isoBase64URL.toBuffer(options.user.id))).toBe('usr_a');
    expect(options.challenge.length).toBeGreaterThan(20);
    expect(options.attestation).toBe('none');
    expect(options.authenticatorSelection?.residentKey).toBe('preferred');
    expect(options.excludeCredentials).toEqual([
      expect.objectContaining({ id: 'existing-cred', transports: ['usb'] }),
    ]);
  });

  it('stores the passkey and mints recovery codes for a passkey-only user', async () => {
    const result = await register('usr_a', 'cred-1');
    expect(result.firstFactor).toBe(true);
    expect(result.recoveryCodes).toHaveLength(8);
    expect(result.passkey).toMatchObject({ backedUp: true, deviceType: 'multiDevice', name: 'Synced passkey' });

    const [row] = mini.rows(userPasskeys);
    expect(row).toMatchObject({ userId: 'usr_a', credentialId: 'cred-1', rpId: RP.rpId, counter: 0 });
    expect(mini.rows(userTotpRecoveryCodes).filter((r) => r.userId === 'usr_a')).toHaveLength(8);
    const user = mini.rows(users).find((u) => u.id === 'usr_a')!;
    expect(user.tfa).toMatchObject({ enabled: true, method: 'webauthn', methods: ['webauthn'], passkeys: 1 });

    // Verification ran against the ceremony's own challenge, origin and RP ID.
    const call = lib.verifyRegistrationResponse.mock.calls[0]![0];
    expect(call.expectedOrigin).toEqual(RP.origins);
    expect(call.expectedRPID).toBe(RP.rpId);
    expect(typeof call.expectedChallenge).toBe('string');
  });

  it('does not mint new recovery codes on a second passkey', async () => {
    await register('usr_a', 'cred-1');
    const second = await register('usr_a', 'cred-2');
    expect(second.firstFactor).toBe(false);
    expect(second.recoveryCodes).toBeNull();
    expect(mini.rows(userTotpRecoveryCodes)).toHaveLength(8);
  });

  it('does not touch the recovery codes of a TOTP user', async () => {
    mini.seed(userTotpCredentials, [{ userId: 'usr_a', secretCiphertext: 'c', secretKeyId: 'v1', enrolledAt: new Date(), verifiedAt: new Date() }]);
    mini.seed(userTotpRecoveryCodes, [{ userId: 'usr_a', codeHash: 'h1' }]);
    const result = await register('usr_a', 'cred-1');
    expect(result.firstFactor).toBe(false);
    expect(result.recoveryCodes).toBeNull();
    expect(mini.rows(userTotpRecoveryCodes).map((r) => r.codeHash)).toEqual(['h1']);
    const user = mini.rows(users).find((u) => u.id === 'usr_a')!;
    expect(user.tfa).toMatchObject({ enabled: true, method: 'totp', methods: ['totp', 'webauthn'] });
  });

  it('a ceremony is single-use and bound to its user', async () => {
    const { ceremonyId } = await svc.beginPasskeyRegistration(db, cache, {
      userId: 'usr_a', userName: 'a', displayName: 'a', rp: RP,
    });
    // Another user cannot redeem it…
    await expect(
      svc.finishPasskeyRegistration(db, cache, { userId: 'usr_b', ceremonyId, response: regResponse() }),
    ).rejects.toMatchObject({ code: 'CEREMONY_EXPIRED' });
    // …and the attempt burned it for the owner too.
    lib.verifyRegistrationResponse.mockResolvedValue(verifiedRegistration('cred-1'));
    await expect(
      svc.finishPasskeyRegistration(db, cache, { userId: 'usr_a', ceremonyId, response: regResponse() }),
    ).rejects.toMatchObject({ code: 'CEREMONY_EXPIRED' });
    expect(mini.rows(userPasskeys)).toHaveLength(0);
  });

  it('rejects a response the library cannot verify, storing nothing', async () => {
    const { ceremonyId } = await svc.beginPasskeyRegistration(db, cache, {
      userId: 'usr_a', userName: 'a', displayName: 'a', rp: RP,
    });
    lib.verifyRegistrationResponse.mockRejectedValue(new Error('Unexpected registration response origin'));
    await expect(
      svc.finishPasskeyRegistration(db, cache, { userId: 'usr_a', ceremonyId, response: regResponse() }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSKEY' });
    expect(mini.rows(userPasskeys)).toHaveLength(0);
  });

  it('refuses a credential id that is already registered', async () => {
    seedPasskey({ userId: 'usr_b', credentialId: 'cred-1' });
    await expect(register('usr_a', 'cred-1')).rejects.toMatchObject({ code: 'PASSKEY_EXISTS' });
  });
});

describe('authentication options', () => {
  it('second factor: allows only the user’s own credentials for this RP ID', async () => {
    seedPasskey({ userId: 'usr_a', credentialId: 'mine', transports: ['internal'] });
    seedPasskey({ userId: 'usr_a', credentialId: 'other-domain', rpId: 'old.example.com' });
    seedPasskey({ userId: 'usr_b', credentialId: 'theirs' });
    const { options } = await svc.beginPasskeyAuthentication(db, cache, {
      kind: 'mfa', rp: RP, userId: 'usr_a', siteId: 'site-a', jti: 'jti-1',
    });
    expect(options.rpId).toBe(RP.rpId);
    expect(options.userVerification).toBe('preferred');
    expect(options.allowCredentials?.map((c) => c.id)).toEqual(['mine']);
  });

  it('second factor without a passkey is refused', async () => {
    await expect(
      svc.beginPasskeyAuthentication(db, cache, { kind: 'mfa', rp: RP, userId: 'usr_a', siteId: 's', jti: 'j' }),
    ).rejects.toMatchObject({ code: 'NO_PASSKEY' });
  });

  it('passwordless: discoverable (no allow list) and user verification required', async () => {
    const { options, ceremonyId } = await svc.beginPasskeyAuthentication(db, cache, { kind: 'login', rp: RP, siteId: 'site-a' });
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe('required');
    const ceremony = await svc.consumeCeremony(cache, ceremonyId);
    expect(ceremony).toMatchObject({ kind: 'login', siteId: 'site-a', rpId: RP.rpId, challenge: options.challenge });
  });
});

describe('consumeCeremony', () => {
  it('returns a ceremony once, then never again', async () => {
    const { ceremonyId } = await svc.beginPasskeyAuthentication(db, cache, { kind: 'login', rp: RP, siteId: 's' });
    expect(await svc.consumeCeremony(cache, ceremonyId)).not.toBeNull();
    expect(await svc.consumeCeremony(cache, ceremonyId)).toBeNull();
  });

  it('fails closed when the cache cannot count', async () => {
    const { ceremonyId } = await svc.beginPasskeyAuthentication(db, cache, { kind: 'login', rp: RP, siteId: 's' });
    vi.spyOn(cache, 'increment').mockRejectedValueOnce(new Error('redis down'));
    expect(await svc.consumeCeremony(cache, ceremonyId)).toBeNull();
  });

  it('rejects an expired record even if the cache still holds it', async () => {
    const { ceremonyId } = await svc.beginPasskeyAuthentication(db, cache, { kind: 'login', rp: RP, siteId: 's' });
    vi.useFakeTimers({ now: Date.now() + (svc.CEREMONY_TTL_SECONDS + 1) * 1000, toFake: ['Date'] });
    try {
      expect(await svc.consumeCeremony(cache, ceremonyId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('verifyPasskeyAssertion', () => {
  const ceremony = (over: Partial<import('../passkey-service').CeremonyRecord> = {}) => ({
    kind: 'login' as const,
    challenge: 'chal',
    rpId: RP.rpId,
    origins: RP.origins,
    siteId: 'site-a',
    expiresAt: Date.now() + 60_000,
    ...over,
  });
  const handleOf = (userId: string) => isoBase64URL.fromBuffer(new TextEncoder().encode(userId));

  it('accepts a valid assertion and advances the stored counter', async () => {
    seedPasskey({ userId: 'usr_a', credentialId: 'cred-1', counter: 4 });
    lib.verifyAuthenticationResponse.mockResolvedValue(verifiedAssertion(5));
    const res = await svc.verifyPasskeyAssertion(db, ceremony(), authResponse('cred-1', handleOf('usr_a')));
    expect(res).toMatchObject({ ok: true, userId: 'usr_a' });
    const row = mini.rows(userPasskeys)[0]!;
    expect(row.counter).toBe(5);
    expect(row.lastUsedAt).toBeInstanceOf(Date);
    const call = lib.verifyAuthenticationResponse.mock.calls[0]![0];
    expect(call).toMatchObject({ expectedChallenge: 'chal', expectedRPID: RP.rpId, requireUserVerification: true });
    expect(call.credential.counter).toBe(0);
  });

  it('rejects a counter regression and leaves the stored counter alone', async () => {
    seedPasskey({ userId: 'usr_a', credentialId: 'cred-1', counter: 10 });
    lib.verifyAuthenticationResponse.mockResolvedValue(verifiedAssertion(7));
    const res = await svc.verifyPasskeyAssertion(db, ceremony(), authResponse('cred-1'));
    expect(res).toMatchObject({ ok: false, reason: 'counter_regression', storedCounter: 10, receivedCounter: 7 });
    expect(mini.rows(userPasskeys)[0]!.counter).toBe(10);
  });

  it('treats an always-zero counter as valid', async () => {
    seedPasskey({ userId: 'usr_a', credentialId: 'cred-1', counter: 0 });
    lib.verifyAuthenticationResponse.mockResolvedValue(verifiedAssertion(0));
    expect((await svc.verifyPasskeyAssertion(db, ceremony(), authResponse('cred-1'))).ok).toBe(true);
  });

  it('second factor: a credential of another user is refused before any crypto', async () => {
    seedPasskey({ userId: 'usr_b', credentialId: 'theirs' });
    const res = await svc.verifyPasskeyAssertion(db, ceremony({ kind: 'mfa', userId: 'usr_a' }), authResponse('theirs'));
    expect(res).toMatchObject({ ok: false, reason: 'user_mismatch' });
    expect(lib.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('passwordless: a user handle naming someone else is refused', async () => {
    seedPasskey({ userId: 'usr_a', credentialId: 'cred-1' });
    const res = await svc.verifyPasskeyAssertion(db, ceremony(), authResponse('cred-1', handleOf('usr_b')));
    expect(res).toMatchObject({ ok: false, reason: 'user_mismatch' });
  });

  it('unknown credentials and credentials of another RP ID are refused', async () => {
    seedPasskey({ userId: 'usr_a', credentialId: 'old', rpId: 'old.example.com' });
    expect(await svc.verifyPasskeyAssertion(db, ceremony(), authResponse('nope'))).toMatchObject({ reason: 'unknown_credential' });
    expect(await svc.verifyPasskeyAssertion(db, ceremony(), authResponse('old'))).toMatchObject({ reason: 'unknown_credential' });
  });

  it('a signature the library rejects is invalid', async () => {
    seedPasskey({ userId: 'usr_a', credentialId: 'cred-1' });
    lib.verifyAuthenticationResponse.mockRejectedValue(new Error('signature'));
    expect(await svc.verifyPasskeyAssertion(db, ceremony(), authResponse('cred-1'))).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('isCounterRegression (oracle)', () => {
  it('matches the WebAuthn §6.1.1 rule for every pair', () => {
    fc.assert(
      fc.property(fc.nat({ max: 2 ** 32 - 1 }), fc.nat({ max: 2 ** 32 - 1 }), (stored, received) => {
        const oracle = (stored !== 0 || received !== 0) && !(received > stored);
        expect(svc.isCounterRegression(stored, received)).toBe(oracle);
      }),
    );
  });
});

describe('removing factors', () => {
  it('removing the last passkey drops the recovery codes and the enrolled flag', async () => {
    await register('usr_a', 'cred-1');
    const id = mini.rows(userPasskeys)[0]!.id as string;
    const out = await svc.deletePasskey(db, 'usr_a', id);
    expect(out).toEqual({ deleted: true, anyFactorLeft: false });
    expect(mini.rows(userTotpRecoveryCodes)).toHaveLength(0);
    expect(mini.rows(users).find((u) => u.id === 'usr_a')!.tfa).toEqual({});
  });

  it('cannot delete another user’s passkey', async () => {
    seedPasskey({ userId: 'usr_b', credentialId: 'theirs' });
    const id = mini.rows(userPasskeys)[0]!.id as string;
    expect(await svc.deletePasskey(db, 'usr_a', id)).toEqual({ deleted: false, anyFactorLeft: true });
    expect(mini.rows(userPasskeys)).toHaveLength(1);
  });

  it('disabling TOTP keeps the shared recovery codes while a passkey remains', async () => {
    mini.seed(userTotpCredentials, [{ userId: 'usr_a', secretCiphertext: 'c', secretKeyId: 'v1', enrolledAt: new Date(), verifiedAt: new Date() }]);
    mini.seed(userTotpRecoveryCodes, [{ userId: 'usr_a', codeHash: 'h1' }]);
    seedPasskey({ userId: 'usr_a', credentialId: 'cred-1' });
    await disableUserTotp(db, 'usr_a');
    expect(mini.rows(userTotpCredentials)).toHaveLength(0);
    expect(mini.rows(userTotpRecoveryCodes)).toHaveLength(1);
    expect(mini.rows(users).find((u) => u.id === 'usr_a')!.tfa).toMatchObject({ enabled: true, method: 'webauthn' });
  });

  it('disabling TOTP with no passkey clears everything, as before', async () => {
    mini.seed(userTotpCredentials, [{ userId: 'usr_a', secretCiphertext: 'c', secretKeyId: 'v1', enrolledAt: new Date(), verifiedAt: new Date() }]);
    mini.seed(userTotpRecoveryCodes, [{ userId: 'usr_a', codeHash: 'h1' }]);
    await disableUserTotp(db, 'usr_a');
    expect(mini.rows(userTotpRecoveryCodes)).toHaveLength(0);
    expect(mini.rows(users).find((u) => u.id === 'usr_a')!.tfa).toEqual({});
  });
});
