import { verifyEd25519 } from '@lumibase/contracts/extensions';
import { z } from 'zod';

/**
 * Signed release manifest (#869) — how LumiBase "gives the command" that turns
 * a dark feature on for an instance.
 *
 * Wire format (the envelope):
 *
 *   { "keyId": "lumibase-release-v1",
 *     "payload": "<base64 of the UTF-8 JSON payload>",
 *     "signature": "<base64 Ed25519 signature over the decoded payload bytes>" }
 *
 * Signing the exact payload bytes avoids any JSON canonicalisation question:
 * the verifier checks the bytes it was given and only then parses them.
 *
 * Payload:
 *
 *   { "v": 1,
 *     "issuedAt": "2026-11-17T09:00:00Z",
 *     "notAfter": "2026-12-01T00:00:00Z",      // optional: refuse to ACCEPT after this
 *     "audience": "*" | ["instance-id", ...],
 *     "flags": { "content-environments": true } }
 *
 * Acceptance rules, in order: well-formed envelope → known key id → valid
 * signature → well-formed payload → not issued in the future (5 min skew) →
 * `notAfter` not passed → audience includes this instance → strictly newer
 * than the manifest already accepted (same `issuedAt` and same bytes is an
 * idempotent no-op). The last rule is what stops a captured older manifest from
 * being replayed to roll flags back; to turn a feature off, issue a newer
 * manifest with the flag `false`.
 *
 * `notAfter` only limits acceptance. Once accepted, a manifest stays in force
 * until a newer one replaces it — an instance that cannot reach LumiBase keeps
 * its last verified state instead of losing features.
 */

export const MANIFEST_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** Upper bound on the encoded payload, so a hostile body cannot be large. */
export const MANIFEST_MAX_PAYLOAD_CHARS = 64 * 1024;

export const releaseManifestEnvelopeSchema = z.object({
  keyId: z.string().min(1).max(100),
  payload: z.string().min(1).max(MANIFEST_MAX_PAYLOAD_CHARS),
  signature: z.string().min(1).max(512),
});
export type ReleaseManifestEnvelope = z.infer<typeof releaseManifestEnvelopeSchema>;

export const releaseManifestPayloadSchema = z.object({
  v: z.literal(1),
  issuedAt: z.string().datetime({ offset: true }),
  notAfter: z.string().datetime({ offset: true }).optional(),
  audience: z.union([z.literal('*'), z.array(z.string().min(1).max(200)).min(1).max(1000)]),
  flags: z.record(z.string().min(1).max(200), z.boolean()),
});
export type ReleaseManifestPayload = z.infer<typeof releaseManifestPayloadSchema>;

export type ManifestRejection =
  | 'MALFORMED_ENVELOPE'
  | 'UNKNOWN_KEY'
  | 'BAD_SIGNATURE'
  | 'MALFORMED_PAYLOAD'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'WRONG_AUDIENCE'
  | 'STALE';

export interface VerifiedManifest {
  readonly envelope: ReleaseManifestEnvelope;
  readonly payload: ReleaseManifestPayload;
  readonly issuedAtMs: number;
}

export type VerifyManifestResult =
  | { ok: true; manifest: VerifiedManifest; unchanged: boolean }
  | { ok: false; reason: ManifestRejection };

export interface VerifyManifestOptions {
  /** `{ keyId: publicKeyPem }` from `LUMIBASE_RELEASE_PUBLIC_KEYS`. */
  readonly publicKeys: Readonly<Record<string, string>>;
  /** `LUMIBASE_INSTANCE_ID`; `null` matches only `audience: "*"`. */
  readonly instanceId: string | null;
  readonly now: number;
  /** The manifest currently accepted, if any. */
  readonly current?: { readonly issuedAtMs: number; readonly payload: string } | null;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
    return Uint8Array.from(atob(value), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Verify an envelope. Never throws: every refusal is a typed reason. */
export async function verifyReleaseManifest(
  input: unknown,
  options: VerifyManifestOptions,
): Promise<VerifyManifestResult> {
  const envelope = releaseManifestEnvelopeSchema.safeParse(input);
  if (!envelope.success) return { ok: false, reason: 'MALFORMED_ENVELOPE' };
  const { keyId, payload, signature } = envelope.data;

  const publicKeyPem = Object.hasOwn(options.publicKeys, keyId) ? options.publicKeys[keyId] : undefined;
  if (!publicKeyPem) return { ok: false, reason: 'UNKNOWN_KEY' };

  const bytes = decodeBase64(payload);
  if (!bytes) return { ok: false, reason: 'MALFORMED_ENVELOPE' };
  if (!(await verifyEd25519(publicKeyPem, signature, bytes))) return { ok: false, reason: 'BAD_SIGNATURE' };

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return { ok: false, reason: 'MALFORMED_PAYLOAD' };
  }
  const parsed = releaseManifestPayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'MALFORMED_PAYLOAD' };

  const issuedAtMs = Date.parse(parsed.data.issuedAt);
  const manifest: VerifiedManifest = { envelope: envelope.data, payload: parsed.data, issuedAtMs };
  const current = options.current;
  // Re-delivery of the manifest already in force is a no-op even after its
  // `notAfter` (which only limits acceptance) — checked before the time and
  // audience rules so a pull URL that keeps serving it does not report failure.
  if (current && issuedAtMs === current.issuedAtMs && payload === current.payload) {
    return { ok: true, manifest, unchanged: true };
  }
  if (issuedAtMs > options.now + MANIFEST_MAX_FUTURE_SKEW_MS) return { ok: false, reason: 'NOT_YET_VALID' };
  if (parsed.data.notAfter && Date.parse(parsed.data.notAfter) < options.now) {
    return { ok: false, reason: 'EXPIRED' };
  }

  const audience = parsed.data.audience;
  if (audience !== '*' && (!options.instanceId || !audience.includes(options.instanceId))) {
    return { ok: false, reason: 'WRONG_AUDIENCE' };
  }

  if (current && issuedAtMs <= current.issuedAtMs) return { ok: false, reason: 'STALE' };
  return { ok: true, manifest, unchanged: false };
}

/**
 * Parse `LUMIBASE_RELEASE_PUBLIC_KEYS` — a JSON object `{ keyId: pem }`, the
 * same shape as `MARKETPLACE_PUBLIC_KEYS`. Several keys allow rotation. Escaped
 * `\n` in a PEM (common in env files) is restored. Anything else → no keys.
 */
export function parseReleasePublicKeys(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [keyId, pem] of Object.entries(value)) {
      if (typeof pem === 'string' && pem.includes('BEGIN PUBLIC KEY')) out[keyId] = pem.replace(/\\n/g, '\n');
    }
    return out;
  } catch {
    return {};
  }
}
