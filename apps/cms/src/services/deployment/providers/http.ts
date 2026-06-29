import { validateOutboundUrl } from '../../ssrf-guard';

/**
 * Shared guarded fetch for provider adapters. Applies the same SSRF policy and
 * timeout as the Flow `http` operation (flow-service.ts), so every outbound
 * call to a Provider API is uniformly protected.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const guard = validateOutboundUrl(url);
  if (!guard.allowed || !guard.url) {
    throw new Error(`outbound URL blocked: ${guard.reason ?? 'not allowed'}`);
  }
  const { timeoutMs = 30_000, ...rest } = init;
  return fetch(guard.url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
}

/** Bearer auth header for token-based provider APIs. */
export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * HMAC of `body` keyed by `secret`, returned as lowercase hex. Uses Web Crypto
 * (`crypto.subtle`) so it runs on both Cloudflare Workers and Node. `algo` is a
 * SubtleCrypto hash name, e.g. `SHA-1` (Vercel) or `SHA-256`.
 */
export async function hmacHex(secret: string, body: string, algo: 'SHA-1' | 'SHA-256'): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: algo },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison (avoids leaking match length via timing).
 * Both inputs are compared over the longer length so early-exit can't shortcut.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** base64url-encode raw bytes (JWS signing input compare). */
function b64url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Verify a compact JWS (`header.payload.signature`) signed with HS256, keyed by
 * `secret`. Used by Netlify outgoing-notification signatures. Returns false on
 * any structural or signature mismatch. Web Crypto → CF + Node compatible.
 */
export async function verifyJwsHs256(jws: string, secret: string): Promise<boolean> {
  if (!secret || !jws) return false;
  const parts = jws.split('.');
  if (parts.length !== 3) return false;
  const [header, payload, signature] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${payload}`));
  return timingSafeEqual(signature ?? '', b64url(sig));
}
