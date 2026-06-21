import { describe, expect, it } from 'vitest';
import { EnvKeyProvider } from '@lumibase/runtime';
import { CryptoService, DecryptionError } from '../../crypto-service';
import {
  newEnvelopeRecordCipher,
  openEnvelopeRecordCipher,
  sharedRecordCipher,
} from '../record-cipher';
import type { CryptoContext } from '../aad';

/**
 * Record-cipher unit tests (regulated-content-readiness task 3.6; Req 4.5).
 */

const KEK_V0 = Buffer.alloc(32, 7).toString('base64');
const KEK_V1 = Buffer.alloc(32, 9).toString('base64');
const ctx = (over: Partial<CryptoContext> = {}): CryptoContext => ({
  siteId: 'site_1',
  collection: 'patients',
  field: 'ssn',
  recordId: 'rec_1',
  ...over,
});

describe('RecordCipher — shared mode', () => {
  it('round-trips through the site key with no wrapped DEK', async () => {
    const crypto = CryptoService.fromKey(KEK_V0);
    const cipher = sharedRecordCipher(crypto);
    expect(cipher.wrappedDek).toBeNull();
    const ct = await cipher.encrypt('123-45-6789', ctx());
    expect(ct).not.toContain('123-45-6789');
    expect(await cipher.decrypt(ct, ctx())).toBe('123-45-6789');
  });
});

describe('RecordCipher — envelope mode', () => {
  it('mints a wrapped DEK and round-trips field values', async () => {
    const keys = new EnvKeyProvider(new Map([['v0', KEK_V0]]), 'v0');
    const cipher = await newEnvelopeRecordCipher(keys, 'site_1', 'rec_1');
    expect(cipher.wrappedDek).toBeTruthy();

    const ct = await cipher.encrypt('secret', ctx());
    expect(ct).not.toContain('secret');

    // A fresh reader unwraps the same DEK and decrypts.
    const reader = await openEnvelopeRecordCipher(keys, 'site_1', 'rec_1', cipher.wrappedDek!);
    expect(await reader.decrypt(ct, ctx())).toBe('secret');
  });

  it('binds field ciphertext to its AAD — a swapped field/record fails closed', async () => {
    const keys = new EnvKeyProvider(new Map([['v0', KEK_V0]]), 'v0');
    const cipher = await newEnvelopeRecordCipher(keys, 'site_1', 'rec_1');
    const ct = await cipher.encrypt('secret', ctx({ field: 'ssn' }));
    const reader = await openEnvelopeRecordCipher(keys, 'site_1', 'rec_1', cipher.wrappedDek!);
    await expect(reader.decrypt(ct, ctx({ field: 'dob' }))).rejects.toThrow();
  });

  it('decrypts after KEK rotation (wrapped DEK keeps its KEK version)', async () => {
    const v0 = new EnvKeyProvider(new Map([['v0', KEK_V0]]), 'v0');
    const cipher = await newEnvelopeRecordCipher(v0, 'site_1', 'rec_1');
    const ct = await cipher.encrypt('secret', ctx());

    // Rotate KEK: v1 active, v0 retired. The wrapped DEK is still v0-wrapped.
    const rotated = new EnvKeyProvider(new Map([['v0', KEK_V0], ['v1', KEK_V1]]), 'v1');
    const reader = await openEnvelopeRecordCipher(rotated, 'site_1', 'rec_1', cipher.wrappedDek!);
    expect(await reader.decrypt(ct, ctx())).toBe('secret');
  });

  it('fails closed when the KEK is gone (crypto-shred semantics)', async () => {
    const keys = new EnvKeyProvider(new Map([['v0', KEK_V0]]), 'v0');
    const cipher = await newEnvelopeRecordCipher(keys, 'site_1', 'rec_1');
    // KEK provider that no longer has v0.
    const noKek = new EnvKeyProvider(new Map([['v1', KEK_V1]]), 'v1');
    await expect(
      openEnvelopeRecordCipher(noKek, 'site_1', 'rec_1', cipher.wrappedDek!),
    ).rejects.toBeInstanceOf(DecryptionError);
  });
});
