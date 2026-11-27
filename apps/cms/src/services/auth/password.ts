/**
 * Password hashing helpers — PBKDF2-SHA256 via Web Crypto API.
 *
 * Hash format (canonical, runtime-portable):
 *   `pbkdf2$<iterations>$<saltHex>$<hashHex>`
 *
 * Web Crypto is used (instead of `node:crypto`) so the helpers run on both
 * Node (self-hosted) and Cloudflare Workers without a runtime branch. The
 * scheme is byte-compatible with the inline implementation previously living
 * in `apps/cms/src/routes/auth.ts`, so existing `users.passwordHash` rows
 * continue to verify after extraction.
 *
 * References:
 *   - Req 3.6 (PBKDF2-SHA256, ≥100k iterations, ≥16 byte salt)
 *   - Req 14.2 (shared helper used by setup + login + recovery)
 *   - design.md §6.5 (extract helper for SetupService reuse)
 */

import { pbkdf2 as pbkdf2Js } from '@noble/hashes/pbkdf2';
import { scrypt as scryptJs } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha2';

const PBKDF2_ITERATIONS = 100_000;
/** Upper bound for `PASSWORD_PBKDF2_ITERATIONS` (#994). */
export const MAX_PBKDF2_ITERATIONS = 2_000_000;
/** Cloudflare Workers' Web Crypto refuses PBKDF2 above 100,000 iterations. */
export const WORKERS_MAX_PBKDF2_ITERATIONS = 100_000;
/** Env knob for the PBKDF2 work factor of NEW hashes (Node/Docker only). */
export const PBKDF2_ITERATIONS_ENV = 'PASSWORD_PBKDF2_ITERATIONS';
const SALT_BYTES = 16;
const HASH_BITS = 256;
const SCHEME = 'pbkdf2';
const SCRYPT_SCHEME = 'scrypt';
/** Env knob for the scheme of NEW password hashes (B230). */
export const PASSWORD_HASH_SCHEME_ENV = 'PASSWORD_HASH_SCHEME';
/**
 * scrypt cost for new hashes (B230): OWASP's N=2^15, r=8, p=3, 32 MiB per
 * hash, memory-hard. Stored in the hash, so a later change re-hashes on login.
 */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 3 } as const;

/** What a new password hash is made with. */
export type PasswordHashPolicy =
  | { scheme: 'pbkdf2'; iterations: number }
  | { scheme: 'scrypt'; N: number; r: number; p: number };

const textEncoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

/** Constant-time byte comparison; returns true only when buffers match. */
function bytesEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  bits: number,
): Promise<Uint8Array> {
  // Workers' Web Crypto refuses more than 100,000 iterations. A hash made
  // with more (on Node/Docker) is still verified, in JavaScript, so moving a
  // database to Workers never locks its users out (B230).
  if (iterations > WORKERS_MAX_PBKDF2_ITERATIONS && isWorkersRuntime()) {
    return pbkdf2Js(sha256, textEncoder.encode(password), salt, { c: iterations, dkLen: bits / 8 });
  }
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    bits,
  );
  return new Uint8Array(derived);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const nodeImport = (id: string): Promise<any> => import(/* @vite-ignore */ id);

/**
 * scrypt, natively on Node (`node:crypto`, faster and off the event loop) and in
 * JavaScript elsewhere (Cloudflare Workers). Both produce the same bytes.
 */
async function scryptBytes(password: string, salt: Uint8Array, N: number, r: number, p: number, dkLen: number): Promise<Uint8Array> {
  if (!isWorkersRuntime() && typeof process !== 'undefined' && process.versions?.node) {
    try {
      const { scrypt } = await nodeImport('node:crypto');
      return await new Promise<Uint8Array>((resolve, reject) => {
        scrypt(password, salt, dkLen, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err: Error | null, key: Uint8Array) =>
          err ? reject(err) : resolve(new Uint8Array(key)));
      });
    } catch {
      // Fall through to the portable implementation.
    }
  }
  return scryptJs(textEncoder.encode(password), salt, { N, r, p, dkLen });
}

/**
 * Hash a plaintext password with a fresh 16-byte salt. `target` is a policy,
 * or a PBKDF2 iteration count (default 100,000) for callers that predate
 * policies. Formats:
 *   `pbkdf2$<iterations>$<saltHex>$<hashHex>`
 *   `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`  (B230)
 */
export async function hashPassword(plaintext: string, target: number | PasswordHashPolicy = PBKDF2_ITERATIONS): Promise<string> {
  const policy = toPolicy(target);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  if (policy.scheme === 'scrypt') {
    const hash = await scryptBytes(plaintext, salt, policy.N, policy.r, policy.p, HASH_BITS / 8);
    return [SCRYPT_SCHEME, policy.N, policy.r, policy.p, toHex(salt), toHex(hash)].join('$');
  }
  const hash = await pbkdf2(plaintext, salt, policy.iterations, HASH_BITS);
  return [SCHEME, policy.iterations, toHex(salt), toHex(hash)].join('$');
}

function toPolicy(target: number | PasswordHashPolicy): PasswordHashPolicy {
  return typeof target === 'number' ? { scheme: 'pbkdf2', iterations: target } : target;
}

/**
 * The policy for new password hashes (B230). `PASSWORD_HASH_SCHEME` picks
 * `scrypt` or `pbkdf2`; unset, it is `scrypt` on Node/Docker (native, fast)
 * and `pbkdf2` on Cloudflare Workers, where scrypt runs in JavaScript
 * (about 300 ms of CPU per hash: set `scrypt` there only on a plan whose CPU
 * limit allows it). PBKDF2 uses {@link targetPbkdf2Iterations}.
 */
export function targetPasswordPolicy(env?: Readonly<Record<string, unknown>>): PasswordHashPolicy {
  const raw = env?.[PASSWORD_HASH_SCHEME_ENV] ?? (typeof process !== 'undefined' ? process.env[PASSWORD_HASH_SCHEME_ENV] : undefined);
  const scheme = raw === 'scrypt' || raw === 'pbkdf2' ? raw : isWorkersRuntime() ? 'pbkdf2' : 'scrypt';
  if (scheme === 'scrypt') return { scheme: 'scrypt', ...SCRYPT_PARAMS };
  return { scheme: 'pbkdf2', iterations: targetPbkdf2Iterations(env) };
}

/** Stable key for a policy (e.g. to cache one dummy hash per policy). */
export function passwordPolicyKey(policy: PasswordHashPolicy): string {
  return policy.scheme === 'scrypt' ? `scrypt:${policy.N}:${policy.r}:${policy.p}` : `pbkdf2:${policy.iterations}`;
}

/** True when running on Cloudflare Workers. */
function isWorkersRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
}

/**
 * Work factor for new password hashes (#994). `PASSWORD_PBKDF2_ITERATIONS`
 * raises it on Node/Docker (clamped to 100,000–2,000,000). On Cloudflare
 * Workers it is always 100,000: Workers' Web Crypto refuses more, and a hash
 * it cannot verify would lock the user out. For the same reason, do not raise
 * it on a Docker deployment whose database may later be served by Workers.
 */
export function targetPbkdf2Iterations(env?: Readonly<Record<string, unknown>>): number {
  if (isWorkersRuntime()) return WORKERS_MAX_PBKDF2_ITERATIONS;
  const raw = env?.[PBKDF2_ITERATIONS_ENV] ?? (typeof process !== 'undefined' ? process.env[PBKDF2_ITERATIONS_ENV] : undefined);
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed)) return PBKDF2_ITERATIONS;
  return Math.min(MAX_PBKDF2_ITERATIONS, Math.max(PBKDF2_ITERATIONS, parsed));
}

/**
 * Whether a successful login should re-hash the stored hash (#994, B230): it
 * uses another scheme than the target, or a weaker cost (fewer PBKDF2
 * iterations; a smaller scrypt N, r or p). Malformed hashes return false.
 */
export function passwordNeedsRehash(stored: string | null | undefined, target: number | PasswordHashPolicy): boolean {
  if (typeof stored !== 'string') return false;
  const policy = toPolicy(target);
  const parts = stored.split('$');
  const int = (v: string | undefined) => {
    const n = Number.parseInt(v ?? '', 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  if (parts[0] === SCHEME && parts.length === 4) {
    const iterations = int(parts[1]);
    if (iterations === null) return false;
    return policy.scheme !== 'pbkdf2' || iterations < policy.iterations;
  }
  if (parts[0] === SCRYPT_SCHEME && parts.length === 6) {
    const [N, r, p] = [int(parts[1]), int(parts[2]), int(parts[3])];
    if (N === null || r === null || p === null) return false;
    if (policy.scheme !== 'scrypt') return true;
    return N < policy.N || r < policy.r || p < policy.p;
  }
  return false;
}

/**
 * Verify a plaintext password against a previously stored hash. Returns
 * `false` for any malformed input rather than throwing, so callers can map
 * directly to `INVALID_CREDENTIALS` without leaking parser state.
 *
 * The final byte comparison is constant-time to avoid leaking byte position
 * timing (Req 7.5 — user-enumeration / login-timing parity).
 */
export async function verifyPassword(
  plaintext: string,
  stored: string,
): Promise<boolean> {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts[0] === SCRYPT_SCHEME) return verifyScrypt(plaintext, parts);
  if (parts.length !== 4) return false;

  const [scheme, iterationsRaw, saltHex, hashHex] = parts;
  if (scheme !== SCHEME || !iterationsRaw || !saltHex || !hashHex) return false;

  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  const salt = fromHex(saltHex);
  const expected = fromHex(hashHex);
  if (!salt || !expected) return false;

  const bits = expected.length * 8;
  if (bits === 0) return false;

  const candidate = await pbkdf2(plaintext, salt, iterations, bits);
  return bytesEqualConstantTime(candidate, expected);
}

/** Upper bounds on stored scrypt parameters, so a forged hash cannot exhaust memory. */
const MAX_SCRYPT_N = 2 ** 20;
const MAX_SCRYPT_R = 32;
const MAX_SCRYPT_P = 16;

async function verifyScrypt(plaintext: string, parts: string[]): Promise<boolean> {
  if (parts.length !== 6) return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number.parseInt(nRaw ?? '', 10);
  const r = Number.parseInt(rRaw ?? '', 10);
  const p = Number.parseInt(pRaw ?? '', 10);
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  // N must be a power of two above 1; the bounds keep memory and CPU finite.
  if (N < 2 || (N & (N - 1)) !== 0 || N > MAX_SCRYPT_N || r > MAX_SCRYPT_R || p > MAX_SCRYPT_P) return false;
  const salt = fromHex(saltHex ?? '');
  const expected = fromHex(hashHex ?? '');
  if (!salt || !expected) return false;
  try {
    const candidate = await scryptBytes(plaintext, salt, N, r, p, expected.length);
    return bytesEqualConstantTime(candidate, expected);
  } catch {
    return false;
  }
}
