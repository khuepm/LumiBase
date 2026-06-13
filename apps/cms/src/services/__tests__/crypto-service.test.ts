import { describe, it, expect, vi } from 'vitest';
import { CryptoService, arrayBufferToBase64, base64ToArrayBuffer } from '../crypto-service';

describe('CryptoService', () => {
  // Generate a valid 256-bit (32 bytes) AES key encoded in base64
  const TEST_KEY = 'v8/w2R+g2g/v8/w2R+g2g/v8/w2R+g2g/v8/w2R+g2g=';
  // Another key for testing decryption failure
  const WRONG_KEY = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqr';

  describe('base64 <-> arrayBuffer utilities', () => {
    it('should correctly convert back and forth', () => {
      const buffer = new Uint8Array([1, 2, 3, 255, 0]).buffer;
      const base64 = arrayBufferToBase64(buffer);
      const restoredBuffer = base64ToArrayBuffer(base64);
      expect(new Uint8Array(restoredBuffer)).toEqual(new Uint8Array([1, 2, 3, 255, 0]));
    });
  });

  describe('encrypt and decrypt', () => {
    it('should successfully encrypt and decrypt a string', async () => {
      const cryptoService = new CryptoService(TEST_KEY);
      const plaintext = 'sensitive_information';

      const encryptedBase64 = await cryptoService.encrypt(plaintext);

      expect(typeof encryptedBase64).toBe('string');
      expect(encryptedBase64).not.toBe(plaintext);
      expect(encryptedBase64).not.toContain(plaintext);

      const decrypted = await cryptoService.decrypt(encryptedBase64);
      expect(decrypted).toBe(plaintext);
    });

    it('should successfully encrypt and decrypt an object', async () => {
      const cryptoService = new CryptoService(TEST_KEY);
      const data = { secret: 'super_secret_value', id: 42 };

      const encryptedBase64 = await cryptoService.encrypt(data);
      expect(encryptedBase64).not.toContain('super_secret_value');

      const decrypted = await cryptoService.decrypt(encryptedBase64);
      expect(decrypted).toEqual(data);
    });

    it('should return a fallback string when decrypting with a wrong key', async () => {
      const cryptoService = new CryptoService(TEST_KEY);
      const plaintext = 'sensitive_data';
      const encryptedBase64 = await cryptoService.encrypt(plaintext);

      // Attempt to decrypt with a different key
      const badCryptoService = new CryptoService(WRONG_KEY);
      const decrypted = await badCryptoService.decrypt(encryptedBase64);

      expect(decrypted).toBe('*** (decryption failed) ***');
    });

    it('should return a fallback string when decrypting malformed data', async () => {
      const cryptoService = new CryptoService(TEST_KEY);
      const decrypted = await cryptoService.decrypt('not_a_valid_base64_string!!!!');
      expect(decrypted).toBe('*** (decryption failed) ***');
    });

    it('should produce different ciphertexts for the same plaintext due to random IV', async () => {
      const cryptoService = new CryptoService(TEST_KEY);
      const plaintext = 'identical_plaintext';

      const encrypted1 = await cryptoService.encrypt(plaintext);
      const encrypted2 = await cryptoService.encrypt(plaintext);

      expect(encrypted1).not.toBe(encrypted2);

      // Both should still decrypt to the same plaintext
      expect(await cryptoService.decrypt(encrypted1)).toBe(plaintext);
      expect(await cryptoService.decrypt(encrypted2)).toBe(plaintext);
    });
  });
});
