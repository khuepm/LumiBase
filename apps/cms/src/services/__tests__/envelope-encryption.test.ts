import { describe, it, expect } from 'vitest';
import {
  generateDek,
  wrapDek,
  unwrapDek,
  encryptFieldWithDek,
  decryptFieldWithDek,
  isEnvelopeEnabled,
} from '../crypto/envelope-encryption';
import { buildAad } from '../crypto/aad';
import { EnvKeyProvider } from '@lumibase/runtime';

const KEK_V0 = Buffer.alloc(32, 1).toString('base64');
const KEK_V1 = Buffer.alloc(32, 2).toString('base64');
const keys = new EnvKeyProvider(new Map([['v0', KEK_V0], ['v1', KEK_V1]]), 'v0');

describe('envelope encryption (Req 4.5)', () => {
  it('generates a 256-bit DEK', () => {
    const dek = generateDek();
    expect(Buffer.from(dek, 'base64').length).toBe(32);
    expect(dek).not.toBe(generateDek());
  });

  it('wraps and unwraps a DEK under the active KEK', async () => {
    const dek = generateDek();
    const wrapped = await wrapDek(keys, dek, 'site1', 'rec1');
    expect(wrapped.startsWith('v0:')).toBe(true);
    expect(await unwrapDek(keys, wrapped, 'site1', 'rec1')).toBe(dek);
  });

  it('fails to unwrap with a mismatched record AAD', async () => {
    const wrapped = await wrapDek(keys, generateDek(), 'site1', 'rec1');
    await expect(unwrapDek(keys, wrapped, 'site1', 'rec2')).rejects.toBeTruthy();
  });

  it('round-trips field values under a record DEK with AAD', async () => {
    const dek = generateDek();
    const ctx = { siteId: 'site1', collection: 'patients', field: 'ssn', recordId: 'rec1' };
    const ct = await encryptFieldWithDek(dek, '123-45-6789', buildAad(ctx));
    expect(ct).not.toContain('123-45-6789');
    expect(await decryptFieldWithDek(dek, ct, buildAad(ctx))).toBe('123-45-6789');
  });

  it('crypto-shred: a lost wrapped DEK makes field ciphertext unrecoverable', async () => {
    const dek = generateDek();
    const ctx = { siteId: 'site1', collection: 'patients', field: 'ssn', recordId: 'rec1' };
    const ct = await encryptFieldWithDek(dek, 'secret', buildAad(ctx));
    // Without the DEK (dek_wrapped deleted), there is no path back to plaintext:
    // a different DEK cannot decrypt it.
    await expect(decryptFieldWithDek(generateDek(), ct, buildAad(ctx))).rejects.toBeTruthy();
  });

  it('survives KEK rotation: DEK wrapped under v0 still unwraps after v1 active', async () => {
    const dek = generateDek();
    const wrappedV0 = await wrapDek(keys, dek, 'site1', 'rec1');
    const rotated = new EnvKeyProvider(new Map([['v0', KEK_V0], ['v1', KEK_V1]]), 'v1');
    expect(await unwrapDek(rotated, wrappedV0, 'site1', 'rec1')).toBe(dek);
    // New wraps use the active v1 KEK.
    expect((await wrapDek(rotated, dek, 'site1', 'rec2')).startsWith('v1:')).toBe(true);
  });

  it('isEnvelopeEnabled reads the flag', () => {
    expect(isEnvelopeEnabled({ LUMIBASE_ENVELOPE_ENCRYPTION: 'true' })).toBe(true);
    expect(isEnvelopeEnabled({})).toBe(false);
    expect(isEnvelopeEnabled(undefined)).toBe(false);
  });
});
