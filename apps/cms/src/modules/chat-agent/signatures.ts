/**
 * Request signatures for inbound chat traffic (#711).
 *
 * Both schemes are HMAC-SHA256 over the RAW body plus a timestamp, compared in
 * constant time, and refused outside a five-minute window so a captured
 * request cannot be replayed later. The window also bounds what the per-event
 * idempotency table has to remember.
 *
 * - Slack (https://api.slack.com/authentication/verifying-requests-from-slack):
 *   `X-Slack-Signature: v0=<hex(HMAC(secret, "v0:" + ts + ":" + body))>`,
 *   `X-Slack-Request-Timestamp: <unix seconds>`.
 * - Generic webhook: `X-Lumibase-Signature: v1=<hex(HMAC(secret, ts + "." + body))>`,
 *   `X-Lumibase-Timestamp: <unix seconds>`.
 */

/** Accepted clock skew, seconds. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'stale_timestamp' | 'mismatch' };

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string equality (length leak only). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function freshTimestamp(timestamp: string | undefined, nowSeconds: number): number | null {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return null;
  const ts = Number(timestamp);
  return Math.abs(nowSeconds - ts) <= SIGNATURE_TOLERANCE_SECONDS ? ts : null;
}

interface VerifyInput {
  secret: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  /** Injectable clock, unix seconds. */
  now?: number;
}

export async function verifySlackSignature(input: VerifyInput): Promise<SignatureVerdict> {
  if (!input.signature || !input.timestamp) return { ok: false, reason: 'missing' };
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (freshTimestamp(input.timestamp, now) === null) return { ok: false, reason: 'stale_timestamp' };
  const expected = `v0=${await hmacHex(input.secret, `v0:${input.timestamp}:${input.rawBody}`)}`;
  return timingSafeEqual(expected, input.signature) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

export async function verifyWebhookSignature(input: VerifyInput): Promise<SignatureVerdict> {
  if (!input.signature || !input.timestamp) return { ok: false, reason: 'missing' };
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (freshTimestamp(input.timestamp, now) === null) return { ok: false, reason: 'stale_timestamp' };
  const expected = `v1=${await hmacHex(input.secret, `${input.timestamp}.${input.rawBody}`)}`;
  return timingSafeEqual(expected, input.signature) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Signs a generic-webhook request (for callers, tests and docs). */
export async function signWebhookRequest(secret: string, rawBody: string, timestamp: number): Promise<string> {
  return `v1=${await hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}

/** Signs a Slack-style request (tests). */
export async function signSlackRequest(secret: string, rawBody: string, timestamp: number): Promise<string> {
  return `v0=${await hmacHex(secret, `v0:${timestamp}:${rawBody}`)}`;
}

/** 256-bit random secret, hex. */
export function generateSigningSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}
