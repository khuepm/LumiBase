/**
 * Draft preview mode — the signed cookie behind `/api/preview`.
 *
 * Plain Web Crypto, no Node APIs and no SvelteKit imports, so it runs the same
 * in a Cloudflare Pages Function, in `vite dev`, and in a unit test.
 *
 * The cookie is NOT a flag. A cookie that merely said `preview=1` could be set
 * by anyone in their own browser; this one is `<expiry>.<HMAC(expiry)>`, keyed
 * by LUMIBASE_PREVIEW_SECRET, so only someone who presented the secret can
 * hold a valid one, it expires on its own, and rotating the secret revokes
 * every outstanding preview session at once.
 */

export const PREVIEW_COOKIE = 'lumibase_preview';
/** One hour. Re-enter preview from Studio (or the preview link) after that. */
export const PREVIEW_TTL_SECONDS = 60 * 60;
/** Shorter secrets are treated as "preview disabled", not as a weak secret. */
export const MIN_SECRET_LENGTH = 32;

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

async function sha256(value: string): Promise<string> {
  return toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

/** Compare without an early exit, so timing does not reveal a matching prefix. */
export function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function previewSecretUsable(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

/**
 * Does the secret a caller presented match the configured one? Both sides are
 * hashed first, so the comparison runs over equal-length strings and leaks
 * neither the secret's length nor a matching prefix.
 */
export async function secretMatches(provided: string | null, expected: string | undefined): Promise<boolean> {
  if (!previewSecretUsable(expected) || typeof provided !== 'string' || provided.length === 0) {
    return false;
  }
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  return constantTimeEqual(a, b);
}

const message = (expiresAt: number) => `lumibase-preview:${expiresAt}`;

/** Mint a cookie value valid for PREVIEW_TTL_SECONDS from `nowMs`. */
export async function issuePreviewCookie(secret: string, nowMs: number = Date.now()): Promise<string> {
  const expiresAt = Math.floor(nowMs / 1000) + PREVIEW_TTL_SECONDS;
  return `${expiresAt}.${await hmac(secret, message(expiresAt))}`;
}

/** True only for an unexpired cookie signed with the current secret. */
export async function verifyPreviewCookie(
  secret: string | undefined,
  value: string | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!previewSecretUsable(secret) || typeof value !== 'string') return false;
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(nowMs / 1000)) return false;
  // A cookie claiming to live longer than one TTL was not minted here.
  if (expiresAt > Math.floor(nowMs / 1000) + PREVIEW_TTL_SECONDS) return false;
  return constantTimeEqual(match[2] as string, await hmac(secret, message(expiresAt)));
}

/**
 * Where to send the editor after entering preview. Same-origin paths only —
 * `//evil.example` and `/\evil.example` are protocol-relative URLs to a
 * browser, so they are refused along with anything absolute.
 */
export function safeRedirectPath(input: string | null): string {
  if (typeof input !== 'string' || !input.startsWith('/')) return '/';
  if (input.startsWith('//') || input.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f]/.test(input)) return '/';
  return input;
}
