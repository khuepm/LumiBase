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

/**
 * Hash a plaintext password using PBKDF2-SHA256 with a freshly generated
 * 16-byte salt and 100k iterations. Returns the canonical encoded string.
 */
export async function hashPassword(plaintext: string, iterations: number = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await pbkdf2(plaintext, salt, iterations, HASH_BITS);
  return `${SCHEME}$${iterations}$${toHex(salt)}$${toHex(hash)}`;
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
 * Whether a stored hash was made with fewer iterations than `target`, so a
 * successful login should re-hash it (#994). Malformed hashes return false.
 */
export function passwordNeedsRehash(stored: string | null | undefined, target: number): boolean {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== SCHEME) return false;
  const iterations = Number.parseInt(parts[1] ?? '', 10);
  return Number.isInteger(iterations) && iterations > 0 && iterations < target;
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
