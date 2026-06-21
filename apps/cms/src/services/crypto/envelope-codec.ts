/**
 * Ciphertext envelope codec.
 *
 * New ciphertext is prefixed with a key-version envelope `"{keyId}:{body}"`
 * (e.g. `v1:AAAA...`). The `keyId` selects which key decrypts the payload and
 * the prefix also signals that the ciphertext was bound to an AAD context
 * (Req 2). Legacy ciphertext written by the original CryptoService has no
 * prefix; since base64 never contains a colon it is unambiguously detected and
 * treated as version `v0` encrypted *without* AAD (Req 3.1, 3.2).
 */

export const LEGACY_KEY_ID = 'v0';

export interface ParsedEnvelope {
  /** Key version id used to encrypt the payload. */
  keyId: string;
  /** Base64-encoded `iv || ciphertext` body. */
  body: string;
  /**
   * True when the ciphertext predates the envelope format (no prefix) and was
   * therefore encrypted without AAD binding.
   */
  legacy: boolean;
}

/** Format a versioned ciphertext envelope. */
export function formatEnvelope(keyId: string, body: string): string {
  if (!keyId || keyId.includes(':')) {
    throw new Error(`Invalid keyId for envelope: '${keyId}'`);
  }
  return `${keyId}:${body}`;
}

/**
 * Parse a ciphertext string into its envelope parts. A value without a `:`
 * separator is treated as a legacy `v0` payload (no version, no AAD).
 */
export function parseEnvelope(value: string): ParsedEnvelope {
  const sep = value.indexOf(':');
  if (sep === -1) {
    return { keyId: LEGACY_KEY_ID, body: value, legacy: true };
  }
  return {
    keyId: value.slice(0, sep),
    body: value.slice(sep + 1),
    legacy: false,
  };
}
