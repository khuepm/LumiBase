import { describe, it, expect } from 'vitest';
import { EnvKeyProvider } from '@lumibase/runtime';
import { encryptToken, decryptToken } from '../token-vault';

const KEK_V0 = Buffer.alloc(32, 7).toString('base64');
const KEK_V1 = Buffer.alloc(32, 9).toString('base64');

describe('deployment token vault', () => {
  it('round-trips a token under the active KEK and never stores plaintext', async () => {
    const keys = new EnvKeyProvider(new Map([['v0', KEK_V0]]), 'v0');
    const token = 'vercel_secret_abc123';
    const enc = await encryptToken(keys, token, 'site1');

    expect(enc.keyId).toBe('v0');
    expect(enc.ciphertext.startsWith('v0:')).toBe(true);
    expect(enc.ciphertext).not.toContain(token);

    expect(await decryptToken(keys, enc.ciphertext, 'site1')).toBe(token);
  });

  it('fails to decrypt under a mismatched site AAD', async () => {
    const keys = new EnvKeyProvider(new Map([['v0', KEK_V0]]), 'v0');
    const enc = await encryptToken(keys, 'tkn', 'site1');
    await expect(decryptToken(keys, enc.ciphertext, 'site2')).rejects.toBeTruthy();
  });

  it('decrypts a token wrapped under a now-retired key (rotation)', async () => {
    // Encrypt while v0 is active…
    const oldKeys = new EnvKeyProvider(new Map([['v0', KEK_V0]]), 'v0');
    const enc = await encryptToken(oldKeys, 'rotated', 'site1');

    // …then v1 becomes active but v0 stays available for decrypt.
    const newKeys = new EnvKeyProvider(new Map([['v0', KEK_V0], ['v1', KEK_V1]]), 'v1');
    expect(await decryptToken(newKeys, enc.ciphertext, 'site1')).toBe('rotated');
  });

  it('rejects legacy (unversioned) ciphertext', async () => {
    const keys = new EnvKeyProvider(new Map([['v0', KEK_V0]]), 'v0');
    await expect(decryptToken(keys, 'no-colon-legacy-body', 'site1')).rejects.toThrow(/versioned envelope/);
  });

  it('refuses to encrypt an empty token', async () => {
    const keys = new EnvKeyProvider(new Map([['v0', KEK_V0]]), 'v0');
    await expect(encryptToken(keys, '', 'site1')).rejects.toThrow();
  });
});
