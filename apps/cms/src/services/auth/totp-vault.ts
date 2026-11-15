import type { KeyProvider } from '@lumibase/runtime';
import { openSecret, sealSecret } from '../crypto/sealed-secret';

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
  return sealSecret(keys, totpAad(userId), base32Secret);
}

export async function decryptTotpSecret(
  keys: KeyProvider,
  userId: string,
  ciphertext: string,
): Promise<string> {
  try {
    return await openSecret(keys, totpAad(userId), ciphertext);
  } catch (err) {
    if (err instanceof Error && err.message === 'Sealed secret must be a versioned envelope.') {
      throw new Error('TOTP ciphertext must be a versioned envelope.');
    }
    throw err;
  }
}
