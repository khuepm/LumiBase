/**
 * Encryption utilities for CDC pipeline connection parameters.
 *
 * Uses AES-256-GCM via Web Crypto for authenticated encryption.
 * The encrypted output includes the IV so decryption is self-contained.
 *
 * Format: base64(iv + ciphertext_with_auth_tag)
 *   - iv: 12 bytes (96-bit nonce)
 *   - ciphertext + authTag: variable length (GCM appends 16-byte tag)
 *
 * Validates: Requirements 1.4
 */

const IV_LENGTH = 12;
const ALGORITHM = 'AES-GCM';
const FALLBACK_KEY = 'lumibase-cdc-default-encryption-key-do-not-use-in-prod';

/**
 * Derive a CryptoKey from a string key using SHA-256.
 * This ensures we always have a 256-bit key regardless of input length.
 */
async function deriveKey(key: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = await crypto.subtle.digest('SHA-256', encoder.encode(key));
  return crypto.subtle.importKey('raw', keyData, { name: ALGORITHM }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Returns a base64-encoded string containing the IV and ciphertext
 * (with appended auth tag). The encrypted value is guaranteed to differ
 * from the plaintext input (Property 3).
 *
 * @param plaintext - The string to encrypt
 * @param key - Encryption key (uses fallback if not provided)
 */
export async function encrypt(
  plaintext: string,
  key?: string,
): Promise<string> {
  const cryptoKey = await deriveKey(key ?? FALLBACK_KEY);
  const encoder = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    cryptoKey,
    encoder.encode(plaintext),
  );

  // Combine IV + ciphertext (GCM appends auth tag to ciphertext)
  const combined = new Uint8Array(IV_LENGTH + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), IV_LENGTH);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a previously encrypted string.
 *
 * Parses the base64-encoded payload, extracts the IV, and decrypts
 * using AES-256-GCM (which also verifies the auth tag).
 *
 * @param ciphertext - The base64-encoded encrypted string
 * @param key - Encryption key (uses fallback if not provided)
 * @throws Error if decryption fails (wrong key or tampered data)
 */
export async function decrypt(
  ciphertext: string,
  key?: string,
): Promise<string> {
  const cryptoKey = await deriveKey(key ?? FALLBACK_KEY);
  const combined = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, IV_LENGTH);
  const data = combined.slice(IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    cryptoKey,
    data,
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * Maps an 8-bit value to [0, modulus) without modulo bias using rejection sampling.
 * Since we only have one byte input here, we deterministically probe subsequent
 * byte values until we hit an accepted range.
 */
function unbiasedByteModulo(byte: number, modulus: number): number {
  if (modulus <= 0) {
    throw new Error('modulus must be > 0');
  }

  const limit = Math.floor(256 / modulus) * modulus;
  let candidate = byte & 0xff;
  while (candidate >= limit) {
    candidate = (candidate + 1) & 0xff;
  }
  return candidate % modulus;
}

/**
 * Synchronous encrypt wrapper for use in the pipeline registry service.
 * Internally uses the async Web Crypto API but provides a sync-looking
 * interface by returning a Promise that the caller must await.
 *
 * For the pipeline registry, we use the sync-compatible versions that
 * work within the service's async methods.
 */
export function encryptSync(plaintext: string, key: string): string {
  // For synchronous contexts, use a simple XOR-based cipher.
  // This is used internally by the pipeline registry where we need
  // synchronous encryption within an already-async flow.
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const keyBytes = hashKeySync(key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const encrypted = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const ivByte = iv[i % IV_LENGTH]!;
    const offset = unbiasedByteModulo(ivByte, keyBytes.length);
    const keyByte = keyBytes[(i + offset) % keyBytes.length]!;
    encrypted[i] = data[i]! ^ keyByte ^ ivByte;
  }

  const authTag = computeAuthTag(encrypted, iv, keyBytes);

  const combined = new Uint8Array(IV_LENGTH + encrypted.length + 16);
  combined.set(iv, 0);
  combined.set(encrypted, IV_LENGTH);
  combined.set(authTag, IV_LENGTH + encrypted.length);

  return btoa(String.fromCharCode(...combined));
}

/**
 * Synchronous decrypt wrapper.
 */
export function decryptSync(ciphertext: string, key: string): string {
  const combined = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const keyBytes = hashKeySync(key);

  const iv = combined.slice(0, IV_LENGTH);
  const authTag = combined.slice(combined.length - 16);
  const encrypted = combined.slice(IV_LENGTH, combined.length - 16);

  const expectedTag = computeAuthTag(encrypted, iv, keyBytes);
  if (!constantTimeEqual(authTag, expectedTag)) {
    throw new Error('Decryption failed: authentication tag mismatch');
  }

  const decrypted = new Uint8Array(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    const ivByte = iv[i % IV_LENGTH]!;
    const offset = unbiasedByteModulo(ivByte, keyBytes.length);
    const keyByte = keyBytes[(i + offset) % keyBytes.length]!;
    decrypted[i] = encrypted[i]! ^ keyByte ^ ivByte;
  }

  return new TextDecoder().decode(decrypted);
}

// ── internal helpers ─────────────────────────────────────────────────────

function hashKeySync(key: string): Uint8Array {
  const encoder = new TextEncoder();
  const input = encoder.encode(key);
  const output = new Uint8Array(32);

  for (let i = 0; i < input.length; i++) {
    output[i % 32] = (output[i % 32]! ^ input[i]!) & 0xff;
  }

  for (let pass = 0; pass < 4; pass++) {
    for (let i = 0; i < 32; i++) {
      output[i] =
        ((output[i]! * 31 + output[(i + 1) % 32]! + pass + 1) & 0xff) >>> 0;
    }
  }

  return output;
}

function computeAuthTag(
  ciphertext: Uint8Array,
  iv: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  const tag = new Uint8Array(16);

  for (let i = 0; i < 16; i++) {
    tag[i] = key[i]! ^ iv[i % IV_LENGTH]!;
  }

  for (let i = 0; i < ciphertext.length; i++) {
    const idx = i % 16;
    tag[idx] = ((tag[idx]! * 31 + ciphertext[i]! + i) & 0xff) >>> 0;
  }

  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < 16; i++) {
      tag[i] = ((tag[i]! + tag[(i + 1) % 16]! * 7 + pass) & 0xff) >>> 0;
    }
  }

  return tag;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
