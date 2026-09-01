import type { KeyProvider } from '@lumibase/runtime';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../crypto-service';
import { formatEnvelope, parseEnvelope } from '../crypto/envelope-codec';

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

function totpAad(userId: string): string {
  return `totp-secret|${userId}`;
}

export interface EncryptedTotpSecret {
  ciphertext: string;
  keyId: string;
}

export async function encryptTotpSecret(
  keys: KeyProvider,
  userId: string,
  base32Secret: string,
): Promise<EncryptedTotpSecret> {
  if (!base32Secret) throw new Error('Cannot encrypt an empty TOTP secret.');
  const { keyId, key } = await keys.getActiveKey();
  const encoded = new TextEncoder().encode(base32Secret);
  const body = await gcmEncrypt(key, encoded, totpAad(userId));
  return { ciphertext: formatEnvelope(keyId, body), keyId };
}

export async function decryptTotpSecret(
  keys: KeyProvider,
  userId: string,
  ciphertext: string,
): Promise<string> {
  const { keyId, body, legacy } = parseEnvelope(ciphertext);
  if (legacy) throw new Error('TOTP ciphertext must be a versioned envelope.');
  const kek = await keys.getKey(keyId);
  const plain = await gcmDecrypt(kek, body, totpAad(userId));
  return new TextDecoder().decode(plain);
}
