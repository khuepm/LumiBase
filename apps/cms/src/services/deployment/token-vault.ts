import type { KeyProvider } from '@lumibase/runtime';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../crypto-service';
import { formatEnvelope, parseEnvelope } from '../crypto/envelope-codec';

/**
 * Token vault for deployment integrations (spec: deployment-integrations,
 * design §5). Encrypts Provider API tokens with the runtime KeyProvider
 * (KEK, AES-GCM) so the plaintext never lands in a database column and is
 * never returned by the API.
 *
 * Reuses the same envelope format (`{keyId}:{body}`) as field/DEK encryption
 * so KEK rotation applies uniformly: tokens written under a retired key still
 * decrypt via `keys.getKey(keyId)`, new tokens use `keys.getActiveKey()`.
 *
 * AAD binds the ciphertext to its target so a token envelope cannot be
 * replayed onto a different target row.
 */

async function importAesKey(base64Key: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToArrayBuffer(base64Key), { name: 'AES-GCM' }, false, usage);
}

async function gcmEncrypt(keyB64: string, plaintext: BufferSource, aad: string): Promise<string> {
  const key = await importAesKey(keyB64, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(aad);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return arrayBufferToBase64(combined.buffer);
}

async function gcmDecrypt(keyB64: string, body: string, aad: string): Promise<Uint8Array> {
  const key = await importAesKey(keyB64, ['decrypt']);
  const combined = new Uint8Array(base64ToArrayBuffer(body));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const additionalData = new TextEncoder().encode(aad);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, key, ct);
  return new Uint8Array(plain);
}

/** AAD binding the token ciphertext to its owning site. */
function tokenAad(siteId: string): string {
  return `deploy-token|${siteId}`;
}

export interface EncryptedToken {
  /** Versioned envelope (`{keyId}:{body}`) to store in `token_ciphertext`. */
  ciphertext: string;
  /** Key version that wrapped the token, stored in `token_key_id`. */
  keyId: string;
}

/** Encrypt a Provider token with the active KEK. */
export async function encryptToken(
  keys: KeyProvider,
  plaintext: string,
  siteId: string,
): Promise<EncryptedToken> {
  if (!plaintext) throw new Error('Cannot encrypt an empty token.');
  const { keyId, key } = await keys.getActiveKey();
  const encoded = new TextEncoder().encode(plaintext);
  const body = await gcmEncrypt(key, encoded, tokenAad(siteId));
  return { ciphertext: formatEnvelope(keyId, body), keyId };
}

/** Decrypt a stored Provider token using the KEK version it was wrapped under. */
export async function decryptToken(
  keys: KeyProvider,
  ciphertext: string,
  siteId: string,
): Promise<string> {
  const { keyId, body, legacy } = parseEnvelope(ciphertext);
  if (legacy) throw new Error('Token ciphertext must be a versioned envelope.');
  const kek = await keys.getKey(keyId);
  const plain = await gcmDecrypt(kek, body, tokenAad(siteId));
  return new TextDecoder().decode(plain);
}
