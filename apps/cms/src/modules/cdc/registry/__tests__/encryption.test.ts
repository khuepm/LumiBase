import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, decryptCompat } from '../encryption';

// A valid 256-bit key (32 bytes) base64-encoded for testing
const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));

// A ciphertext produced by the legacy XOR cipher that earlier releases used
// for pipeline connection strings (format: base64(iv12 + xor_body + tag16)).
// decryptCompat must keep decrypting these rows after the AES-GCM migration.
const LEGACY_KEY = 'test-key-for-legacy-fixture';
const LEGACY_PLAINTEXT = 'postgresql://user:pass@host:5432/db';
const LEGACY_CIPHERTEXT =
  'YYnkSMT+pjOopMlx/SjdQVuHRwkYzfCISxt2Ma0muRgNFUDhzLQFeaKuGeB/A9bICYlKIjI+cf7+JAEVQ+Sy';

describe('CDC encryption utilities', () => {
  describe('async encrypt/decrypt (Web Crypto AES-256-GCM)', () => {
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

    it('fails closed when no key is provided (CWE-321: no in-repo fallback)', async () => {
      const plaintext = 'postgresql://user:pass@host:5432/db';
      // There is no default key: encrypting/decrypting without a key must throw
      // rather than silently use a committed default.
      await expect(encrypt(plaintext, '')).rejects.toThrow(/required/i);
      await expect(decrypt('deadbeef', '')).rejects.toThrow(/required/i);
    });
  });

  describe('decryptCompat (AES-GCM with legacy XOR fallback)', () => {
    it('decrypts AES-GCM ciphertext like decrypt', async () => {
      const plaintext = 'postgresql://user:pass@host:5432/db';
      const encrypted = await encrypt(plaintext, TEST_KEY);
      const decrypted = await decryptCompat(encrypted, TEST_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('falls back to the legacy XOR format for pre-migration rows', async () => {
      const decrypted = await decryptCompat(LEGACY_CIPHERTEXT, LEGACY_KEY);
      expect(decrypted).toBe(LEGACY_PLAINTEXT);
    });

    it('rejects a legacy ciphertext with the wrong key', async () => {
      await expect(
        decryptCompat(LEGACY_CIPHERTEXT, 'wrong-key'),
      ).rejects.toThrow('authentication tag mismatch');
    });

    it('rejects tampered legacy ciphertext via the auth tag', async () => {
      const bytes = Uint8Array.from(atob(LEGACY_CIPHERTEXT), (c) =>
        c.charCodeAt(0),
      );
      bytes[14] = bytes[14]! ^ 0xff; // flip a byte in the ciphertext area
      const tampered = btoa(String.fromCharCode(...bytes));

      await expect(decryptCompat(tampered, LEGACY_KEY)).rejects.toThrow(
        'authentication tag mismatch',
      );
    });

    it('rejects garbage that matches neither format', async () => {
      const garbage = btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(48))),
      );
      await expect(decryptCompat(garbage, TEST_KEY)).rejects.toThrow();
    });
  });
});
