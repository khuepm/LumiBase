/**
 * Keyed, per-site hash of a client identifier (an IP address or a principal
 * id) for counters and audit metadata that must not carry the raw value
 * (#564, CWE-359 redact-on-write).
 *
 * HMAC-SHA256 keyed by `JWT_SECRET`, over `lumibase:ai-refusal:v1|{siteId}|{value}`,
 * truncated to 16 hex characters. Keyed because an unkeyed hash of an IPv4
 * address is reversed by brute force in seconds. `siteId` is in the message so
 * the same IP does not correlate across tenants. Rotating `JWT_SECRET` changes
 * every hash, which only breaks correlation across the rotation.
 *
 * Web Crypto only, so it runs on Workers and Node alike.
 */

const DEV_FALLBACK_KEY = 'lumibase-unkeyed-dev';
const HASH_HEX_LENGTH = 16;

const keys = new Map<string, Promise<CryptoKey>>();
let warnedUnkeyed = false;

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    // A failed import must not poison the cache for the next call.
    key.catch(() => keys.delete(secret));
    keys.set(secret, key);
  }
  return key;
}

/** Reads the hash key from bindings, then `process.env`. `null` when neither has one. */
export function clientHashSecret(env: { JWT_SECRET?: string } | undefined): string | null {
  const fromBinding = env?.JWT_SECRET;
  if (fromBinding) return fromBinding;
  try {
    const fromProcess = typeof process !== 'undefined' ? process.env.JWT_SECRET : undefined;
    return fromProcess || null;
  } catch {
    return null;
  }
}

/**
 * 16 lowercase hex characters. With no secret (tests and local dev only:
 * production requires `JWT_SECRET`) a fixed key is used and a warning is
 * printed once per isolate.
 */
export async function hashClientIdentifier(siteId: string, value: string, secret: string | null): Promise<string> {
  if (!secret) {
    if (!warnedUnkeyed) {
      warnedUnkeyed = true;
      console.warn('[client-ip-hash] JWT_SECRET is not set; client identifiers are hashed with a fixed development key.');
    }
  }
  const key = await keyFor(secret || DEV_FALLBACK_KEY);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`lumibase:ai-refusal:v1|${siteId}|${value}`),
  );
  let hex = '';
  for (const byte of new Uint8Array(signature, 0, HASH_HEX_LENGTH / 2)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
