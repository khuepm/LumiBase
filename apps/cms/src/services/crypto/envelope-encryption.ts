import type { KeyProvider } from '@lumibase/runtime';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../crypto-service';
import { formatEnvelope, parseEnvelope } from './envelope-codec';

/**
 * Envelope (DEK/KEK) encryption primitives (regulated-content-readiness Req
 * 4.5, design §5). Optional mode enabled by `LUMIBASE_ENVELOPE_ENCRYPTION`.
 *
 * Model:
 *   - A random per-record **DEK** (Data Encryption Key) encrypts field values.
 *   - The DEK is **wrapped** (encrypted) by the active **KEK** (Key Encryption
 *     Key from the runtime KeyProvider) and stored beside the record in
 *     `items.dek_wrapped`.
 *   - **Crypto-shredding** = deleting `dek_wrapped`: without the wrapped DEK the
 *     field ciphertext is unrecoverable, even from backups (Req 11.2).
 *
 * The wrapped DEK carries the KEK version in the same `v{keyId}:` envelope as
 * field ciphertext, so KEK rotation/rewrap applies to it uniformly.
 */

const DEK_BYTES = 32; // AES-256

async function importAesKey(base64Key: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToArrayBuffer(base64Key), { name: 'AES-GCM' }, false, usage);
}

/** Generate a fresh base64 per-record DEK. */
export function generateDek(): string {
  const raw = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
  return arrayBufferToBase64(raw.buffer);
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

/** AAD binding the wrapped DEK to its record. */
function wrapAad(siteId: string, recordId: string): string {
  return `dek|${siteId}|${recordId}`;
}

/**
 * Wrap a DEK with the active KEK, returning a versioned envelope to persist in
 * `items.dek_wrapped`.
 */
export async function wrapDek(
  keys: KeyProvider,
  dekB64: string,
  siteId: string,
  recordId: string,
): Promise<string> {
  const { keyId, key } = await keys.getActiveKey();
  const dekBytes = new Uint8Array(base64ToArrayBuffer(dekB64));
  const body = await gcmEncrypt(key, dekBytes, wrapAad(siteId, recordId));
  return formatEnvelope(keyId, body);
}

/** Unwrap a stored wrapped DEK using the KEK version it was wrapped under. */
export async function unwrapDek(
  keys: KeyProvider,
  wrapped: string,
  siteId: string,
  recordId: string,
): Promise<string> {
  const { keyId, body, legacy } = parseEnvelope(wrapped);
  if (legacy) throw new Error('Wrapped DEK must be a versioned envelope.');
  const kek = await keys.getKey(keyId);
  const dekBytes = await gcmDecrypt(kek, body, wrapAad(siteId, recordId));
  return arrayBufferToBase64(dekBytes.buffer as ArrayBuffer);
}

/** Encrypt a field value with a record DEK (no version prefix; the DEK is shared per record). */
export async function encryptFieldWithDek(
  dekB64: string,
  value: unknown,
  aad: string,
): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return gcmEncrypt(dekB64, encoded, aad);
}

/** Decrypt a field value with a record DEK. */
export async function decryptFieldWithDek(
  dekB64: string,
  body: string,
  aad: string,
): Promise<unknown> {
  const plain = await gcmDecrypt(dekB64, body, aad);
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Whether envelope mode is enabled for this runtime. */
export function isEnvelopeEnabled(env: Record<string, unknown> | undefined): boolean {
  return (env?.LUMIBASE_ENVELOPE_ENCRYPTION as string) === 'true';
}
