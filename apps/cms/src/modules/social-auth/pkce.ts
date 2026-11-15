/**
 * Random tokens, PKCE (RFC 7636, S256) and constant-time comparison for the
 * social login flow. Web Crypto only — runs on Workers and Node alike.
 */

export function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `bytes` of CSPRNG output, base64url-encoded (32 bytes → 43 chars, 256 bits). */
export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 `code_challenge` for a verifier, method S256. */
export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** RFC 7636 §4.1: 43–128 chars of `[A-Za-z0-9-._~]`. */
export const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is exactly a base64url SHA-256 digest. */
export const PKCE_CHALLENGE_RE = /^[A-Za-z0-9\-_]{43}$/;

/** Constant-time string equality (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i += 1) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** True when `verifier` hashes to `challenge` under S256. */
export async function verifyPkce(verifier: string, challenge: string): Promise<boolean> {
  if (!PKCE_VERIFIER_RE.test(verifier)) return false;
  return timingSafeEqual(await s256(verifier), challenge);
}
