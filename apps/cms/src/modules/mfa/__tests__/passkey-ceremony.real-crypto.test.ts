import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryCacheProvider, type CacheProvider } from '@lumibase/runtime';
import { userPasskeys, users, type Database } from '@lumibase/database';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { createMiniDb, type MiniDb } from '../../../test-utils/mini-drizzle-db';
import type { WebAuthnRp } from '../webauthn-config';
import * as svc from '../passkey-service';

/**
 * Passkey ceremonies end to end with REAL cryptography (#735, #842).
 *
 * `passkey-service.test.ts` mocks the two `verify*` calls. This suite does not:
 * a software authenticator (ES256 over Web Crypto, `none` attestation) answers
 * the options the service generates, and `@simplewebauthn/server` verifies the
 * signatures for real. A library upgrade that changes the wire format, the
 * credential shape the service stores, or how a stored credential is read back
 * fails here rather than in production.
 */

const RP: WebAuthnRp = { rpId: 'studio.example.com', rpName: 'LumiBase', origins: ['https://studio.example.com'] };
const ORIGIN = RP.origins[0]!;

const enc = new TextEncoder();

/** An ArrayBuffer-backed byte array, which is what Web Crypto accepts. */
type Bytes = Uint8Array<ArrayBuffer>;
type CBOR = Parameters<typeof isoCBOR.encode>[0];

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u16 = (n: number) => new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
const sha256 = async (data: Bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));

/** Web Crypto signs ECDSA as raw r||s; WebAuthn carries an ASN.1 DER signature. */
function rawToDer(raw: Uint8Array): Bytes {
  const int = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i += 1;
    let v: Uint8Array = bytes.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

/** A platform authenticator that holds one discoverable ES256 credential. */
class SoftAuthenticator {
  private keys!: CryptoKeyPair;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  private userHandle: Bytes | null = null;
  counter = 0;

  constructor(private readonly userVerifies = true) {}

  get id(): string {
    return isoBase64URL.fromBuffer(this.credentialId);
  }

  private flags(extra = 0): number {
    return FLAG_UP | (this.userVerifies ? FLAG_UV : 0) | extra;
  }

  async create(options: PublicKeyCredentialCreationOptionsJSON, origin = ORIGIN): Promise<RegistrationResponseJSON> {
    this.keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    this.userHandle = new Uint8Array(isoBase64URL.toBuffer(options.user.id));
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', this.keys.publicKey));
    const cosePublicKey = isoCBOR.encode(
      new Map<number, CBOR>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, raw.slice(1, 33)],
        [-3, raw.slice(33, 65)],
      ]),
    );
    const authData = concat(
      await sha256(enc.encode(options.rp.id ?? RP.rpId)),
      new Uint8Array([this.flags(FLAG_AT)]),
      u32(this.counter),
      new Uint8Array(16), // AAGUID
      u16(this.credentialId.length),
      this.credentialId,
      cosePublicKey,
    );
    const attestationObject = isoCBOR.encode(
      new Map<string, CBOR>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, CBOR>()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = enc.encode(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
    };
  }

  async get(
    options: PublicKeyCredentialRequestOptionsJSON,
    { origin = ORIGIN, counter }: { origin?: string; counter?: number } = {},
  ): Promise<AuthenticationResponseJSON> {
    this.counter = counter ?? this.counter + 1;
    const authData = concat(
      await sha256(enc.encode(options.rpId ?? RP.rpId)),
      new Uint8Array([this.flags()]),
      u32(this.counter),
    );
    const clientDataJSON = enc.encode(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }),
    );
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(rawToDer(raw)),
        ...(this.userHandle ? { userHandle: isoBase64URL.fromBuffer(this.userHandle) } : {}),
      },
      clientExtensionResults: {},
    };
  }
}

let mini: MiniDb;
let db: Database;
let cache: CacheProvider;

beforeEach(() => {
  mini = createMiniDb();
  db = mini.db as Database;
  cache = new MemoryCacheProvider();
  mini.seed(users, [
    { id: 'usr_a', email: 'a@example.test', tfa: {}, tokenVersion: 0, status: 'active' },
    { id: 'usr_b', email: 'b@example.test', tfa: {}, tokenVersion: 0, status: 'active' },
  ]);
});

async function registerReal(userId: string, authenticator: SoftAuthenticator) {
  const { ceremonyId, options } = await svc.beginPasskeyRegistration(db, cache, {
    userId,
    userName: `${userId}@example.test`,
    displayName: userId,
    rp: RP,
  });
  const response = await authenticator.create(options);
  return svc.finishPasskeyRegistration(db, cache, { userId, ceremonyId, response });
}

async function assertReal(
  kind: 'mfa' | 'login',
  authenticator: SoftAuthenticator,
  opts: { userId?: string; origin?: string; counter?: number; tamperChallenge?: boolean } = {},
) {
  const { ceremonyId, options } =
    kind === 'mfa'
      ? await svc.beginPasskeyAuthentication(db, cache, {
          kind: 'mfa',
          rp: RP,
          userId: opts.userId ?? 'usr_a',
          siteId: 'site_1',
          jti: 'jti-1',
        })
      : await svc.beginPasskeyAuthentication(db, cache, { kind: 'login', rp: RP, siteId: 'site_1' });
  const challenge = opts.tamperChallenge ? isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32))) : options.challenge;
  const response = await authenticator.get({ ...options, challenge }, opts);
  const ceremony = await svc.consumeCeremony(cache, ceremonyId);
  expect(ceremony).not.toBeNull();
  return { result: await svc.verifyPasskeyAssertion(db, ceremony!, response), ceremony: ceremony!, ceremonyId, response };
}

describe('real passkey ceremonies (software authenticator, unmocked verification)', () => {
  it('registers a passkey and stores a credential the library can verify later', async () => {
    const auth = new SoftAuthenticator();
    const { passkey, firstFactor } = await registerReal('usr_a', auth);

    expect(firstFactor).toBe(true);
    const [row] = mini.rows(userPasskeys);
    expect(row).toMatchObject({
      userId: 'usr_a',
      credentialId: auth.id,
      counter: 0,
      rpId: RP.rpId,
      transports: ['internal', 'hybrid'],
      aaguid: '00000000-0000-0000-0000-000000000000',
    });
    expect(passkey.id).toBe(row!.id);
    // Stored as a base64url COSE key, not an empty placeholder.
    expect(isoBase64URL.toBuffer(row!.publicKey as string).length).toBeGreaterThan(60);
  });

  it('verifies a second-factor assertion and advances the stored counter', async () => {
    const auth = new SoftAuthenticator();
    await registerReal('usr_a', auth);

    const first = await assertReal('mfa', auth);
    expect(first.result).toMatchObject({ ok: true, userId: 'usr_a', userVerified: true });

    const second = await assertReal('mfa', auth);
    expect(second.result.ok).toBe(true);
    expect(mini.rows(userPasskeys)[0]!.counter).toBe(2);
  });

  it('verifies a usernameless login (UV required) and resolves the owner from the user handle', async () => {
    const auth = new SoftAuthenticator();
    await registerReal('usr_a', auth);

    const { result } = await assertReal('login', auth);
    expect(result).toMatchObject({ ok: true, userId: 'usr_a', userVerified: true });
  });

  it('refuses a usernameless login from an authenticator that did not verify the user', async () => {
    const auth = new SoftAuthenticator(false);
    await registerReal('usr_a', auth);

    const { result } = await assertReal('login', auth);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects an assertion signed over a different challenge', async () => {
    const auth = new SoftAuthenticator();
    await registerReal('usr_a', auth);

    const { result } = await assertReal('mfa', auth, { tamperChallenge: true });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects an assertion from a foreign origin', async () => {
    const auth = new SoftAuthenticator();
    await registerReal('usr_a', auth);

    const { result } = await assertReal('mfa', auth, { origin: 'https://evil.example.net' });
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('flags a counter that goes backwards as a cloned-authenticator signal', async () => {
    const auth = new SoftAuthenticator();
    await registerReal('usr_a', auth);
    await assertReal('mfa', auth, { counter: 10 });

    const { result } = await assertReal('mfa', auth, { counter: 3 });
    expect(result).toMatchObject({ ok: false, reason: 'counter_regression', storedCounter: 10, receivedCounter: 3 });
  });

  it('will not redeem the same ceremony twice', async () => {
    const auth = new SoftAuthenticator();
    await registerReal('usr_a', auth);

    const { ceremonyId } = await assertReal('mfa', auth);
    expect(await svc.consumeCeremony(cache, ceremonyId)).toBeNull();
  });

  it("refuses another user's passkey as a second factor", async () => {
    const auth = new SoftAuthenticator();
    await registerReal('usr_a', auth);
    await registerReal('usr_b', new SoftAuthenticator());

    const { result } = await assertReal('mfa', auth, { userId: 'usr_b' });
    expect(result).toMatchObject({ ok: false, reason: 'user_mismatch' });
  });

  it('rejects a registration answered for a different origin', async () => {
    const auth = new SoftAuthenticator();
    const { ceremonyId, options } = await svc.beginPasskeyRegistration(db, cache, {
      userId: 'usr_a',
      userName: 'a@example.test',
      displayName: 'a',
      rp: RP,
    });
    const response = await auth.create(options, 'https://evil.example.net');
    await expect(
      svc.finishPasskeyRegistration(db, cache, { userId: 'usr_a', ceremonyId, response }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSKEY' });
    expect(mini.rows(userPasskeys)).toHaveLength(0);
  });
});
