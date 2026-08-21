import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveIsOfficial,
  sha256Hex,
  verifyBundle,
  type BundleSignature,
  type ResolvedKey,
} from '@lumibase/shared/extensions';

function makeKeypair(): { pem: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { pem, privateKey };
}

async function sign(bundle: Uint8Array, privateKey: KeyObject): Promise<string> {
  // `Buffer` is `any` under @cloudflare/workers-types v5, so `.toString('base64')`
  // does not type-check here. Go through the Web-standard btoa path instead.
  const sig = new Uint8Array(nodeSign(null, bundle, privateKey));
  return btoa(String.fromCharCode(...sig));
}

const bundle = new TextEncoder().encode('export default {};');

describe('verifyBundle reason matrix', () => {
  it('returns ok for a valid official signature', async () => {
    const { pem, privateKey } = makeKeypair();
    const sig: BundleSignature = {
      sha256: await sha256Hex(bundle),
      signature: await sign(bundle, privateKey),
      keyId: 'k1',
      alg: 'ed25519',
    };
    const key: ResolvedKey = { publicKeyPem: pem, publisher: 'LumiBase', official: true, revoked: false };
    const r = await verifyBundle(bundle, sig, () => key);
    expect(r).toMatchObject({ ok: true, reason: 'ok', official: true });
  });

  it('missing-fields when any field absent', async () => {
    const r = await verifyBundle(bundle, { sha256: null, signature: null, keyId: null, alg: null }, () => null);
    expect(r.reason).toBe('missing-fields');
  });

  it('hash-mismatch when the bundle was swapped', async () => {
    const { pem, privateKey } = makeKeypair();
    const sig: BundleSignature = {
      sha256: await sha256Hex(new TextEncoder().encode('different')),
      signature: await sign(bundle, privateKey),
      keyId: 'k1',
      alg: 'ed25519',
    };
    const key: ResolvedKey = { publicKeyPem: pem, publisher: 'x', official: true, revoked: false };
    expect((await verifyBundle(bundle, sig, () => key)).reason).toBe('hash-mismatch');
  });

  it('unknown-key when the resolver returns null', async () => {
    const { privateKey } = makeKeypair();
    const sig: BundleSignature = {
      sha256: await sha256Hex(bundle),
      signature: await sign(bundle, privateKey),
      keyId: 'missing',
      alg: 'ed25519',
    };
    expect((await verifyBundle(bundle, sig, () => null)).reason).toBe('unknown-key');
  });

  it('revoked-key when the key is revoked', async () => {
    const { pem, privateKey } = makeKeypair();
    const sig: BundleSignature = {
      sha256: await sha256Hex(bundle),
      signature: await sign(bundle, privateKey),
      keyId: 'k1',
      alg: 'ed25519',
    };
    const key: ResolvedKey = { publicKeyPem: pem, publisher: 'x', official: true, revoked: true };
    expect((await verifyBundle(bundle, sig, () => key)).reason).toBe('revoked-key');
  });

  it('unsupported-alg rejects rsa-pss (downgrade guard)', async () => {
    const { pem, privateKey } = makeKeypair();
    const sig: BundleSignature = {
      sha256: await sha256Hex(bundle),
      signature: await sign(bundle, privateKey),
      keyId: 'k1',
      alg: 'rsa-pss-sha256',
    };
    const key: ResolvedKey = { publicKeyPem: pem, publisher: 'x', official: true, revoked: false };
    expect((await verifyBundle(bundle, sig, () => key)).reason).toBe('unsupported-alg');
  });

  it('bad-signature when signed by a different key', async () => {
    const { privateKey } = makeKeypair();
    const other = makeKeypair();
    const sig: BundleSignature = {
      sha256: await sha256Hex(bundle),
      signature: await sign(bundle, privateKey),
      keyId: 'k1',
      alg: 'ed25519',
    };
    const key: ResolvedKey = { publicKeyPem: other.pem, publisher: 'x', official: true, revoked: false };
    expect((await verifyBundle(bundle, sig, () => key)).reason).toBe('bad-signature');
  });
});

describe('deriveIsOfficial', () => {
  const okOfficial = { ok: true, reason: 'ok' as const, official: true };
  const okThirdParty = { ok: true, reason: 'ok' as const, official: false };

  it('true only for lumibase-* signed by an official key', () => {
    expect(deriveIsOfficial('lumibase-pageview-counter', okOfficial)).toBe(true);
  });
  it('false for a non-namespaced name even if official-signed', () => {
    expect(deriveIsOfficial('analytics-panel', okOfficial)).toBe(false);
  });
  it('false for lumibase-* signed by a non-official key', () => {
    expect(deriveIsOfficial('lumibase-evil', okThirdParty)).toBe(false);
  });
  it('false when verification failed', () => {
    expect(deriveIsOfficial('lumibase-x', { ok: false, reason: 'bad-signature' })).toBe(false);
  });
});
