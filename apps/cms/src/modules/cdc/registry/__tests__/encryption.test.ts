import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../encryption';

// A valid 256-bit key (32 bytes) base64-encoded for testing
const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));

describe('CDC encryption utilities', () => {
  it('round-trips a connection string through encrypt/decrypt', async () => {
    const plaintext = 'postgresql://user:pass@host:5432/db';
    const encrypted = await encrypt(plaintext, TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypted value is never equal to plaintext', async () => {
    const plaintext = 'clickhouse://default:@localhost:8123/analytics';
    const encrypted = await encrypt(plaintext, TEST_KEY);
    expect(encrypted).not.toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext (random IV)', async () => {
    const plaintext = 'kafka://broker:9092';
    const encrypted1 = await encrypt(plaintext, TEST_KEY);
    const encrypted2 = await encrypt(plaintext, TEST_KEY);
    expect(encrypted1).not.toBe(encrypted2);
  });

  it('decryption fails with wrong key', async () => {
    const plaintext = 'postgresql://admin:secret@prod:5432/main';
    const encrypted = await encrypt(plaintext, TEST_KEY);

    const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(99)));
    await expect(decrypt(encrypted, wrongKey)).rejects.toThrow();
  });

  it('handles empty string', async () => {
    const plaintext = '';
    const encrypted = await encrypt(plaintext, TEST_KEY);
    expect(encrypted).not.toBe(plaintext);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('handles unicode characters in connection strings', async () => {
    const plaintext = 'postgresql://user:pässwörd@host:5432/db?sslmode=require';
    const encrypted = await encrypt(plaintext, TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('handles long connection strings', async () => {
    const plaintext = 'postgresql://very_long_username:very_long_password_with_special_chars_!@#$%@very-long-hostname.region.cloud-provider.com:5432/database_name?sslmode=require&connect_timeout=10&application_name=lumibase-cdc';
    const encrypted = await encrypt(plaintext, TEST_KEY);
    const decrypted = await decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it('uses fallback key when no key is provided', async () => {
    const plaintext = 'postgresql://user:pass@host:5432/db';
    // Both encrypt and decrypt should use the same fallback
    const encrypted = await encrypt(plaintext);
    const decrypted = await decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });
});
