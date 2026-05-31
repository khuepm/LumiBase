import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, encryptSync, decryptSync } from '../encryption';

// A valid 256-bit key (32 bytes) base64-encoded for testing
const TEST_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));
const SYNC_KEY = 'cdc-test-encryption-key-for-sync';

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

    it('uses fallback key when no key is provided', async () => {
      const plaintext = 'postgresql://user:pass@host:5432/db';
      // Both encrypt and decrypt should use the same fallback
      const encrypted = await encrypt(plaintext);
      const decrypted = await decrypt(encrypted);
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('sync encryptSync/decryptSync (used by pipeline registry)', () => {
    it('round-trips a connection string', () => {
      const plaintext = 'postgresql://user:pass@host:5432/db';
      const encrypted = encryptSync(plaintext, SYNC_KEY);
      const decrypted = decryptSync(encrypted, SYNC_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('encrypted value is never equal to plaintext', () => {
      const plaintext = 'clickhouse://default:@localhost:8123/analytics';
      const encrypted = encryptSync(plaintext, SYNC_KEY);
      expect(encrypted).not.toBe(plaintext);
    });

    it('produces different ciphertext for the same plaintext (random IV)', () => {
      const plaintext = 'kafka://broker:9092';
      const encrypted1 = encryptSync(plaintext, SYNC_KEY);
      const encrypted2 = encryptSync(plaintext, SYNC_KEY);
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('decryption fails with wrong key', () => {
      const plaintext = 'postgresql://admin:secret@prod:5432/main';
      const encrypted = encryptSync(plaintext, SYNC_KEY);
      expect(() => decryptSync(encrypted, 'wrong-key')).toThrow(
        'authentication tag mismatch',
      );
    });

    it('handles empty string', () => {
      const plaintext = '';
      const encrypted = encryptSync(plaintext, SYNC_KEY);
      expect(encrypted).not.toBe(plaintext);
      const decrypted = decryptSync(encrypted, SYNC_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('handles unicode characters in connection strings', () => {
      const plaintext = 'postgresql://user:pässwörd@host:5432/db?sslmode=require';
      const encrypted = encryptSync(plaintext, SYNC_KEY);
      const decrypted = decryptSync(encrypted, SYNC_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('handles long connection strings', () => {
      const plaintext = 'postgresql://very_long_username:very_long_password_with_special_chars_!@#$%@very-long-hostname.region.cloud-provider.com:5432/database_name?sslmode=require&connect_timeout=10&application_name=lumibase-cdc';
      const encrypted = encryptSync(plaintext, SYNC_KEY);
      const decrypted = decryptSync(encrypted, SYNC_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('detects tampered ciphertext via auth tag', () => {
      const plaintext = 'postgresql://user:pass@host:5432/db';
      const encrypted = encryptSync(plaintext, SYNC_KEY);

      // Tamper with the ciphertext by flipping a character
      const bytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
      bytes[14] = bytes[14]! ^ 0xff; // flip a byte in the ciphertext area
      const tampered = btoa(String.fromCharCode(...bytes));

      expect(() => decryptSync(tampered, SYNC_KEY)).toThrow(
        'authentication tag mismatch',
      );
    });
  });
});
