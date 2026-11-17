import { generateKeyPairSync, sign } from 'node:crypto';

/** Test-only Ed25519 signer that produces the same envelope LumiBase issues. */
export function makeSigner(keyId = 'test-key') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    keyId,
    publicKeyPem,
    publicKeys: { [keyId]: publicKeyPem } as Record<string, string>,
    envelope(payload: unknown, overrides: Partial<{ keyId: string; signature: string; payload: string }> = {}) {
      const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
      return {
        keyId,
        payload: bytes.toString('base64'),
        signature: sign(null, bytes, privateKey).toString('base64'),
        ...overrides,
      };
    },
  };
}

export const iso = (ms: number) => new Date(ms).toISOString();
