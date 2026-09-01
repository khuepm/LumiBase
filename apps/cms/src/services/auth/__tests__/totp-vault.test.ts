import { describe, expect, it } from 'vitest';
import { EnvKeyProvider } from '@lumibase/runtime';
import { decryptTotpSecret, encryptTotpSecret } from '../totp-vault';

const KEK = Buffer.alloc(32, 7).toString('base64');

describe('totp-vault', () => {
  it('encrypts and decrypts a TOTP secret bound to userId', async () => {
    const keys = new EnvKeyProvider(new Map([['v0', KEK]]), 'v0');
    const userId = 'user_test_001';
    const secret = 'JBSWY3DPEHPK3PXP';
    const enc = await encryptTotpSecret(keys, userId, secret);
    const plain = await decryptTotpSecret(keys, userId, enc.ciphertext);
    expect(plain).toBe(secret);
  });

  it('fails decrypt when AAD userId does not match', async () => {
    const keys = new EnvKeyProvider(new Map([['v0', KEK]]), 'v0');
    const enc = await encryptTotpSecret(keys, 'user_a', 'JBSWY3DPEHPK3PXP');
    await expect(decryptTotpSecret(keys, 'user_b', enc.ciphertext)).rejects.toBeTruthy();
  });
});
