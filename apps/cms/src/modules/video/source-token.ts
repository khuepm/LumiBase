/**
 * Short-lived, signed source URLs (#871). The provider pulls the original
 * from `GET /api/v1/video/source/<token>`; the token names the site, file and
 * version and expires, so a leaked URL serves exactly one binary for a few
 * hours and nothing else. The HMAC key is derived from `JWT_SECRET` with a
 * purpose label, so it never doubles as a session-token key.
 */
import { hmacSha256Hex, timingSafeEqualHex } from './provider';

export const SOURCE_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const PURPOSE = 'lumibase:video-source:v1';

export interface SourceClaims {
  siteId: string;
  fileId: string;
  version: number;
  /** Expiry, epoch ms. */
  exp: number;
}

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function derivedKey(secret: string): Promise<string> {
  return hmacSha256Hex(secret, PURPOSE);
}

export async function signSourceToken(secret: string, claims: SourceClaims): Promise<string> {
  const payload = b64urlEncode(JSON.stringify({ s: claims.siteId, f: claims.fileId, v: claims.version, e: claims.exp }));
  const sig = await hmacSha256Hex(await derivedKey(secret), payload);
  return `${payload}.${sig}`;
}

/** Null for a malformed, forged or expired token. */
export async function verifySourceToken(secret: string, token: string, now: number): Promise<SourceClaims | null> {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacSha256Hex(await derivedKey(secret), payload);
  if (!timingSafeEqualHex(sig.toLowerCase(), expected)) return null;
  let raw: { s?: unknown; f?: unknown; v?: unknown; e?: unknown };
  try {
    raw = JSON.parse(b64urlDecode(payload)) as typeof raw;
  } catch {
    return null;
  }
  if (typeof raw.s !== 'string' || typeof raw.f !== 'string' || typeof raw.v !== 'number' || typeof raw.e !== 'number') return null;
  if (raw.e < now) return null;
  return { siteId: raw.s, fileId: raw.f, version: raw.v, exp: raw.e };
}

/** `site:file:version` — echoed back by the provider on webhooks. */
export function passthroughFor(siteId: string, fileId: string, version: number): string {
  return `${siteId}:${fileId}:${version}`;
}

export function parsePassthrough(p: string | null): { siteId: string; fileId: string; version: number } | null {
  if (!p) return null;
  const m = /^([^:]+):([^:]+):(\d+)$/.exec(p);
  return m ? { siteId: m[1]!, fileId: m[2]!, version: Number(m[3]) } : null;
}
