/**
 * Extension bundle signing + verification primitives.
 *
 * Pure WebCrypto (no Node or Hono deps) so this module is importable by BOTH
 * the CMS Worker (verify at every load path) and the Node signing CLI
 * (`@lumibase/extension-cli`). Signatures are detached Ed25519 over the raw
 * bundle bytes; the bundle's SHA-256 is carried alongside so a swapped bundle
 * fails the hash check before signature verification even runs.
 *
 * Only Ed25519 is implemented. `rsa-pss-sha256` is a recognised algorithm value
 * (the DB column allows it) but verifying it here returns `unsupported-alg`
 * rather than silently passing — an explicit downgrade guard.
 */

export type SignatureAlg = 'ed25519' | 'rsa-pss-sha256';

/** Detached signature metadata carried on a marketplace/registry row. */
export interface BundleSignature {
  sha256: string | null;
  signature: string | null;
  keyId: string | null;
  alg: SignatureAlg | null;
}

/** A publisher key resolved from the env map and/or the DB registry. */
export interface ResolvedKey {
  publicKeyPem: string;
  publisher: string;
  /** Whether this key is trusted to sign official `lumibase-*` extensions. */
  official: boolean;
  revoked: boolean;
}

export type VerifyReason =
  | 'ok'
  | 'missing-fields'
  | 'hash-mismatch'
  | 'unknown-key'
  | 'revoked-key'
  | 'bad-signature'
  | 'unsupported-alg';

export interface VerifyResult {
  ok: boolean;
  reason: VerifyReason;
  keyId?: string;
  /** Copied from the resolved key on success — used to derive isOfficial. */
  official?: boolean;
}

/** Resolves a keyId to its registered public key, or null if unknown. */
export type KeyResolver = (keyId: string) => Promise<ResolvedKey | null> | ResolvedKey | null;

/** Coerce any byte source into a standalone ArrayBuffer (never Shared). */
function toArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  }
  return bytes;
}

/** Hex-encoded SHA-256 of the given bytes. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0));
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

/** Verify a detached Ed25519 signature (base64) over `message`. */
export async function verifyEd25519(
  publicKeyPem: string,
  signatureB64: string,
  message: ArrayBuffer | Uint8Array,
): Promise<boolean> {
  try {
    const der = pemToDer(publicKeyPem);
    const sig = b64ToBytes(signatureB64);
    const key = await crypto.subtle.importKey(
      'spki',
      toArrayBuffer(der),
      { name: 'Ed25519' } as { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      toArrayBuffer(sig),
      toArrayBuffer(message),
    );
  } catch {
    return false;
  }
}

/**
 * Full bundle verification. Never throws — returns a typed reason so callers can
 * make a fail-closed decision. Order matters: fields → hash → key resolution →
 * algorithm → signature.
 */
export async function verifyBundle(
  bundleBytes: ArrayBuffer | Uint8Array,
  sig: BundleSignature,
  resolveKey: KeyResolver,
): Promise<VerifyResult> {
  if (!sig.sha256 || !sig.signature || !sig.keyId || !sig.alg) {
    return { ok: false, reason: 'missing-fields' };
  }

  const computed = await sha256Hex(bundleBytes);
  if (computed !== sig.sha256) {
    return { ok: false, reason: 'hash-mismatch', keyId: sig.keyId };
  }

  const key = await resolveKey(sig.keyId);
  if (!key) return { ok: false, reason: 'unknown-key', keyId: sig.keyId };
  if (key.revoked) return { ok: false, reason: 'revoked-key', keyId: sig.keyId };

  // Downgrade guard: only Ed25519 is implemented. Anything else is refused.
  if (sig.alg !== 'ed25519') {
    return { ok: false, reason: 'unsupported-alg', keyId: sig.keyId };
  }

  const valid = await verifyEd25519(key.publicKeyPem, sig.signature, bundleBytes);
  if (!valid) return { ok: false, reason: 'bad-signature', keyId: sig.keyId };

  return { ok: true, reason: 'ok', keyId: sig.keyId, official: key.official };
}

/**
 * Derive whether an extension is OFFICIAL. Server-side truth only: the name must
 * be in the reserved `lumibase-` namespace AND the bundle must verify against a
 * key flagged `official`. Never trust a manifest's self-asserted flag.
 */
export function deriveIsOfficial(name: string, result: VerifyResult): boolean {
  return name.startsWith('lumibase-') && result.ok && result.official === true;
}

/** Reserved namespace prefix for first-party extensions. */
export const OFFICIAL_NAMESPACE_PREFIX = 'lumibase-';
