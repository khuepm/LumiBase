import { describe, it, expect } from 'vitest';
import {
  decryptSecretValue,
  encryptSecretValue,
  generateWebhookSecret,
  maskToken,
  DecryptionError,
} from '../crypto';

// 256-bit AES key, base64 — deterministic so the round-trip is reproducible.
const KEY = Buffer.alloc(32, 7).toString('base64');
const ctx = { siteId: 'site_a', integrationId: 'int_1' };

describe('git-integration crypto', () => {
  it('round-trips a token through encrypt/decrypt', async () => {
    const token = 'ghp_secrettoken_value_123';
    const ciphertext = await encryptSecretValue(KEY, token, ctx, 'token');
    expect(ciphertext).not.toContain(token);
    const back = await decryptSecretValue(KEY, ciphertext, ctx, 'token');
    expect(back).toBe(token);
  });

  it('fails to decrypt when the AAD site context differs', async () => {
    const ciphertext = await encryptSecretValue(KEY, 'tok', ctx, 'token');
    await expect(
      decryptSecretValue(
        KEY,
        ciphertext,
        { siteId: 'other_site', integrationId: 'int_1' },
        'token',
      ),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('fails to decrypt when the AAD field differs', async () => {
    const ciphertext = await encryptSecretValue(KEY, 'tok', ctx, 'token');
    await expect(
      decryptSecretValue(KEY, ciphertext, ctx, 'webhook_secret'),
    ).rejects.toBeInstanceOf(DecryptionError);
  });

  it('generates a 64-char hex webhook secret', () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(generateWebhookSecret()).not.toBe(s);
  });

  it('masks tokens to a non-revealing fingerprint', () => {
    expect(maskToken(null)).toBeNull();
    expect(maskToken('abcd1234')).toBe('••••1234');
    expect(maskToken('xy')).toBe('••••');
  });
});
