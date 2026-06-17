import { formatSafeError } from '@lumibase/shared/utils';
import type { KeyMeta, KeyProvider, ResolvedKey } from '@lumibase/runtime';
import { formatEnvelope, parseEnvelope } from './crypto/envelope-codec';
import { buildAad, type CryptoContext } from './crypto/aad';

export type { CryptoContext } from './crypto/aad';

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Raised when a field cannot be decrypted (wrong key, corrupt data, or AAD
 * mismatch). Never carries ciphertext, key material, or plaintext (Req 1.3).
 */
export class DecryptionError extends Error {
  readonly code = 'DECRYPTION_FAILED';
  constructor(public readonly keyId?: string) {
    super('Decryption failed');
    this.name = 'DecryptionError';
  }
}

/**
 * Minimal {@link KeyProvider} wrapping a single base64 key as version `v0`.
 * Used for the legacy fallback path (Req 4.4) and tests, so the CryptoService
 * always resolves keys through the same interface.
 */
export class SingleKeyProvider implements KeyProvider {
  constructor(private readonly base64Key: string, private readonly keyId = 'v0') {}
  async getActiveKey(): Promise<ResolvedKey> {
    return { keyId: this.keyId, key: this.base64Key };
  }
  async getKey(keyId: string): Promise<string> {
    if (keyId !== this.keyId && keyId !== 'v0') {
      throw new Error(`SingleKeyProvider has no key '${keyId}'`);
    }
    return this.base64Key;
  }
  async listKeys(): Promise<KeyMeta[]> {
    return [{ keyId: this.keyId, status: 'active', algo: 'AES-GCM' }];
  }
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToArrayBuffer(base64Key);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Symmetric field encryption (AES-GCM) with key versioning, AAD binding, and
 * fail-closed decryption.
 *
 * - New ciphertext is tagged with the active key version and bound to its
 *   `{siteId,collection,field,recordId}` context via AAD.
 * - Decryption selects the key by version, applies the same AAD, and throws
 *   {@link DecryptionError} on any failure rather than returning a placeholder.
 * - Legacy unprefixed ciphertext decrypts as `v0` without AAD.
 */
export class CryptoService {
  constructor(private readonly keys: KeyProvider) {}

  /** Build a CryptoService backed by a single base64 key (legacy/test path). */
  static fromKey(base64Key: string): CryptoService {
    return new CryptoService(new SingleKeyProvider(base64Key));
  }

  async encrypt(data: unknown, ctx: CryptoContext): Promise<string> {
    const { keyId, key } = await this.keys.getActiveKey();
    const cryptoKey = await importKey(key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = new TextEncoder().encode(buildAad(ctx));
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData },
      cryptoKey,
      encoded,
    );
    const combined = new Uint8Array(iv.length + cipherBuffer.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuffer), iv.length);
    return formatEnvelope(keyId, arrayBufferToBase64(combined.buffer));
  }

  async decrypt(payload: string, ctx: CryptoContext): Promise<unknown> {
    const { keyId, body, legacy } = parseEnvelope(payload);

    let key: string;
    try {
      key = await this.keys.getKey(keyId);
    } catch (e) {
      // No key for this version — fail closed without logging material.
      console.error('[crypto] missing key for ciphertext version', formatSafeError(e));
      throw new DecryptionError(keyId);
    }

    try {
      const cryptoKey = await importKey(key);
      const combined = new Uint8Array(base64ToArrayBuffer(body));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      // Legacy ciphertext was written without AAD; only versioned envelopes
      // are AAD-bound.
      const params: { name: 'AES-GCM'; iv: Uint8Array; additionalData?: Uint8Array } = {
        name: 'AES-GCM',
        iv,
      };
      if (!legacy) params.additionalData = new TextEncoder().encode(buildAad(ctx));
      const decryptedBuffer = await crypto.subtle.decrypt(params, cryptoKey, ciphertext);
      const text = new TextDecoder().decode(decryptedBuffer);
      return JSON.parse(text);
    } catch (e) {
      // Never log ciphertext, key, or plaintext (Req 1.3) — message only.
      console.error('[crypto] decryption failed', formatSafeError(e));
      throw new DecryptionError(keyId);
    }
  }
}
