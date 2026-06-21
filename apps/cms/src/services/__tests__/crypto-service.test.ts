import { describe, it, expect } from 'vitest';
import {
  CryptoService,
  DecryptionError,
  SingleKeyProvider,
  arrayBufferToBase64,
  base64ToArrayBuffer,
} from '../crypto-service';
import { formatEnvelope, parseEnvelope, LEGACY_KEY_ID } from '../crypto/envelope-codec';
import { buildAad } from '../crypto/aad';
import { EnvKeyProvider } from '@lumibase/runtime';

const TEST_KEY = 'v8/w2R+g2g/v8/w2R+g2g/v8/w2R+g2g/v8/w2R+g2g=';
const WRONG_KEY = Buffer.alloc(32, 9).toString('base64');
const KEY_V1 = Buffer.alloc(32, 7).toString('base64');

const ctx = { siteId: 'site1', collection: 'patients', field: 'ssn', recordId: 'rec1' };

describe('envelope codec', () => {
  it('round-trips a versioned envelope', () => {
    const env = formatEnvelope('v1', 'AAAA');
    expect(env).toBe('v1:AAAA');
    expect(parseEnvelope(env)).toEqual({ keyId: 'v1', body: 'AAAA', legacy: false });
  });

  it('treats unprefixed base64 as legacy v0', () => {
    const parsed = parseEnvelope('AAAABBBBCCCC');
    expect(parsed).toEqual({ keyId: LEGACY_KEY_ID, body: 'AAAABBBBCCCC', legacy: true });
  });

  it('rejects a keyId containing a colon', () => {
    expect(() => formatEnvelope('v:1', 'x')).toThrow();
  });
});

describe('buildAad', () => {
  it('is canonical and order-independent', () => {
    expect(buildAad(ctx)).toBe('site1|patients|ssn|rec1');
  });
});

describe('CryptoService', () => {
  it('converts base64 <-> arrayBuffer', () => {
    const buffer = new Uint8Array([1, 2, 3, 255, 0]).buffer;
    expect(new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(buffer)))).toEqual(
      new Uint8Array([1, 2, 3, 255, 0]),
    );
  });

  it('encrypts with a versioned envelope and decrypts round-trip', async () => {
    const svc = CryptoService.fromKey(TEST_KEY);
    const ct = await svc.encrypt({ secret: 'super', id: 42 }, ctx);
    expect(ct.startsWith('v0:')).toBe(true);
    expect(ct).not.toContain('super');
    expect(await svc.decrypt(ct, ctx)).toEqual({ secret: 'super', id: 42 });
  });

  it('throws DecryptionError on AAD mismatch (moved ciphertext)', async () => {
    const svc = CryptoService.fromKey(TEST_KEY);
    const ct = await svc.encrypt('value', ctx);
    await expect(svc.decrypt(ct, { ...ctx, recordId: 'rec2' })).rejects.toBeInstanceOf(
      DecryptionError,
    );
  });

  it('throws DecryptionError with a wrong key', async () => {
    const ct = await CryptoService.fromKey(TEST_KEY).encrypt('x', ctx);
    await expect(CryptoService.fromKey(WRONG_KEY).decrypt(ct, ctx)).rejects.toMatchObject({
      code: 'DECRYPTION_FAILED',
    });
  });

  it('throws DecryptionError on malformed data', async () => {
    await expect(
      CryptoService.fromKey(TEST_KEY).decrypt('v0:not-valid-base64!!!', ctx),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('decrypts legacy unprefixed ciphertext (written without AAD)', async () => {
    // Emulate legacy ciphertext: AES-GCM with no AAD and no version prefix.
    const raw = base64ToArrayBuffer(TEST_KEY);
    const cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
      'encrypt',
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(JSON.stringify('legacy-value'));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
    const combined = new Uint8Array(iv.length + cipher.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipher), iv.length);
    const legacyCiphertext = arrayBufferToBase64(combined.buffer);

    const svc = CryptoService.fromKey(TEST_KEY);
    expect(await svc.decrypt(legacyCiphertext, ctx)).toBe('legacy-value');
  });

  it('decrypts ciphertext from a retired key after rotation', async () => {
    const keys = new EnvKeyProvider(
      new Map([
        ['v0', TEST_KEY],
        ['v1', KEY_V1],
      ]),
      'v0',
    );
    const beforeRotate = new CryptoService(keys);
    const ct = await beforeRotate.encrypt('rotated', ctx);
    expect(ct.startsWith('v0:')).toBe(true);

    // Rotate: v1 becomes active; v0 retired but still decryptable.
    const afterRotate = new CryptoService(
      new EnvKeyProvider(
        new Map([
          ['v0', TEST_KEY],
          ['v1', KEY_V1],
        ]),
        'v1',
      ),
    );
    expect((await afterRotate.encrypt('new', ctx)).startsWith('v1:')).toBe(true);
    expect(await afterRotate.decrypt(ct, ctx)).toBe('rotated');
  });

  it('produces distinct ciphertexts for identical plaintext (random IV)', async () => {
    const svc = CryptoService.fromKey(TEST_KEY);
    const a = await svc.encrypt('same', ctx);
    const b = await svc.encrypt('same', ctx);
    expect(a).not.toBe(b);
    expect(await svc.decrypt(a, ctx)).toBe('same');
    expect(await svc.decrypt(b, ctx)).toBe('same');
  });

  it('SingleKeyProvider reports the active key', async () => {
    const p = new SingleKeyProvider(TEST_KEY);
    expect(await p.getActiveKey()).toEqual({ keyId: 'v0', key: TEST_KEY });
    expect(await p.listKeys()).toEqual([{ keyId: 'v0', status: 'active', algo: 'AES-GCM' }]);
  });
});
