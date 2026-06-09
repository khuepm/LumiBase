import { formatSafeError } from '@lumibase/shared/utils';

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

export class CryptoService {
  constructor(private readonly base64Key: string) {}

  private async getKey(): Promise<CryptoKey> {
    const raw = base64ToArrayBuffer(this.base64Key);
    return crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async encrypt(data: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.getKey();
    const encoded = new TextEncoder().encode(JSON.stringify(data));
    const cipherBuffer = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoded
    );
    const combined = new Uint8Array(iv.length + cipherBuffer.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(cipherBuffer), iv.length);
    return arrayBufferToBase64(combined.buffer);
  }

  async decrypt(encryptedBase64: string): Promise<unknown> {
    try {
      const combined = new Uint8Array(base64ToArrayBuffer(encryptedBase64));
      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);
      const key = await this.getKey();
      const decryptedBuffer = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        ciphertext
      );
      const text = new TextDecoder().decode(decryptedBuffer);
      return JSON.parse(text);
    } catch (e) {
      // In case of decryption failure, return a fallback or throw
      console.error('Decryption failed', formatSafeError(e));
      return '*** (decryption failed) ***';
    }
  }
}
