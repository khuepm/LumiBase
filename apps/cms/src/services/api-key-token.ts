/**
 * API key token generation — extracted from the api-keys route so both the
 * route and the governed AI skill (`createApiKey`/`rotateApiKey`) issue tokens
 * identically. Web Crypto only (works on both Workers and Node ≥20).
 */

export interface PlaintextToken {
  /** Full plaintext token — returned to the caller exactly once. */
  token: string;
  /** Stable prefix stored for display/lookup. */
  prefix: string;
  /** SHA-256 hex of the token; only the hash is persisted. */
  tokenHash: string;
}

export async function createPlaintextToken(): Promise<PlaintextToken> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = base64Url(bytes);
  const token = `lbk_${secret}`;
  return {
    token,
    prefix: token.slice(0, 16),
    tokenHash: await sha256Hex(token),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
