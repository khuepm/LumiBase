import type { KeyProvider } from '@lumibase/runtime';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../crypto-service';
import { formatEnvelope, parseEnvelope } from './envelope-codec';

/**
 * Seal a small secret (a TOTP seed, an OAuth client secret, a signing key)
 * under the active KeyProvider key: AES-256-GCM, random 96-bit IV, bound to an
 * `aad` string that names what the secret is and who owns it. The result is a
 * versioned envelope (`{keyId}:{base64(iv||ct)}`), so rotation keeps old
 * ciphertext readable via `getKey(keyId)`.
 *
 * The AAD is what stops a ciphertext from being copied between rows: a secret
 * sealed for `(site A, google)` fails authentication when opened as
 * `(site B, google)`.
 */

async function importAesKey(base64Key: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToArrayBuffer(base64Key), { name: 'AES-GCM' }, false, usage);
}

export async function gcmEncrypt(keyB64: string, plaintext: BufferSource, aad: string): Promise<string> {
  const key = await importAesKey(keyB64, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(aad);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, plaintext);
  const combined = new Uint8Array(iv.length + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), iv.length);
  return arrayBufferToBase64(combined.buffer);
}

export async function gcmDecrypt(keyB64: string, body: string, aad: string): Promise<Uint8Array> {
  const key = await importAesKey(keyB64, ['decrypt']);
  const combined = new Uint8Array(base64ToArrayBuffer(body));
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const additionalData = new TextEncoder().encode(aad);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, key, ct);
  return new Uint8Array(plain);
}

export interface SealedSecret {
  ciphertext: string;
  keyId: string;
}

export async function sealSecret(keys: KeyProvider, aad: string, plaintext: string): Promise<SealedSecret> {
  if (!plaintext) throw new Error('Cannot seal an empty secret.');
  const { keyId, key } = await keys.getActiveKey();
  const body = await gcmEncrypt(key, new TextEncoder().encode(plaintext), aad);
  return { ciphertext: formatEnvelope(keyId, body), keyId };
}

export async function openSecret(keys: KeyProvider, aad: string, ciphertext: string): Promise<string> {
  const { keyId, body, legacy } = parseEnvelope(ciphertext);
  if (legacy) throw new Error('Sealed secret must be a versioned envelope.');
  const kek = await keys.getKey(keyId);
  return new TextDecoder().decode(await gcmDecrypt(kek, body, aad));
}
