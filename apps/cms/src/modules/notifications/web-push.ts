/**
 * Web Push delivery — runtime-agnostic implementation of the encryption and
 * authorization a push service requires, built entirely on the Web Crypto API
 * (`crypto.subtle`) so the same code runs on Cloudflare Workers and Node 18+.
 *
 * We deliberately avoid the `web-push` npm package: it depends on Node's
 * `crypto` module and does not run on Workers. Instead this module implements:
 *
 *   - RFC 8291 — Message Encryption for Web Push (the `aes128gcm` content
 *     encoding from RFC 8188, with the WebPush-specific key derivation).
 *   - RFC 8292 — VAPID: an ES256 JWT proving the application server's identity
 *     to the push service.
 *
 * Nothing here is product-specific; callers hand in a stored subscription
 * (endpoint + the client's `p256dh` / `auth` keys), a JSON payload string, and
 * the VAPID key material read from env. The single record path is sufficient
 * for our notification payloads, which are well under one 4096-byte record.
 *
 * NOTE: end-to-end delivery depends on a live push service (FCM/Mozilla/etc.)
 * and valid VAPID keys; it cannot be exercised in an offline test harness.
 * The deterministic pieces (base64url, VAPID JWT shape) are unit-tested.
 */

const encoder = new TextEncoder();

/**
 * `ArrayBuffer`-backed byte view. TS 5.7+ types a bare `Uint8Array` as
 * `Uint8Array<ArrayBufferLike>`, which no longer satisfies `BufferSource`
 * (it admits `SharedArrayBuffer`). Pinning the backing buffer keeps every
 * Web Crypto call type-clean across runtimes.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** A stored push subscription, mirroring the W3C `PushSubscription` JSON. */
export interface StoredPushSubscription {
  endpoint: string;
  /** Client ECDH P-256 public key, base64url. */
  p256dh: string;
  /** Client auth secret, base64url. */
  auth: string;
}

/** VAPID key material + contact, read from env by the caller. */
export interface VapidKeys {
  /** Application server public key, base64url of the raw 65-byte point. */
  publicKey: string;
  /** Application server private scalar `d`, base64url of 32 bytes. */
  privateKey: string;
  /** Contact `sub` claim — a `mailto:` or `https:` URI. */
  subject: string;
}

/** Outcome of one delivery attempt. `expired` flags a 404/410 (prune the row). */
export interface WebPushResult {
  ok: boolean;
  status: number;
  expired: boolean;
  error?: string;
}

// ── base64url helpers ──────────────────────────────────────────────────────

export function bytesToBase64url(bytes: Bytes): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(input: string): Bytes {
  const padLen = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Bytes[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * HKDF (RFC 5869) via Web Crypto, which performs extract+expand in one call:
 * `deriveBits` extracts a PRK from (salt, ikm) then expands it with `info`.
 */
async function hkdf(
  salt: Bytes,
  ikm: Bytes,
  info: Bytes,
  lengthBytes: number,
): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

// ── RFC 8291 payload encryption (aes128gcm, single record) ──────────────────

/**
 * Encrypt `plaintext` for a subscription's keys per RFC 8291. Returns the full
 * `aes128gcm` body (RFC 8188 header || ciphertext) ready to POST.
 */
export async function encryptPayload(
  plaintext: Bytes,
  uaPublic: Bytes,
  authSecret: Bytes,
): Promise<Bytes> {
  // Per-message ephemeral server ECDH keypair (the "as" / application server).
  const serverKeys = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));

  const uaPublicKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, serverKeys.privateKey, 256),
  );

  // IKM = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0"||ua_pub||as_pub, 32)
  const keyInfo = concatBytes(encoder.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  // Single record: data || 0x02 (last-record delimiter, no extra padding).
  const padded = concatBytes(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded),
  );

  // RFC 8188 header: salt(16) || rs(4, BE) || idlen(1) || keyid(as_public).
  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concatBytes(header, ciphertext);
}

// ── RFC 8292 VAPID ──────────────────────────────────────────────────────────

async function importVapidSigningKey(vapid: VapidKeys): Promise<CryptoKey> {
  const pub = base64urlToBytes(vapid.publicKey); // 65-byte uncompressed point
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64url(pub.slice(1, 33)),
    y: bytesToBase64url(pub.slice(33, 65)),
    d: vapid.privateKey,
    ext: true,
  };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

/**
 * Build the VAPID `Authorization` JWT for a given endpoint. `exp` is capped at
 * 12h (RFC 8292 allows up to 24h); `aud` is the endpoint's origin.
 */
export async function createVapidJwt(endpoint: string, vapid: VapidKeys): Promise<string> {
  const url = new URL(endpoint);
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: `${url.protocol}//${url.host}`,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: vapid.subject,
  };
  const signingInput =
    `${bytesToBase64url(encoder.encode(JSON.stringify(header)))}.` +
    `${bytesToBase64url(encoder.encode(JSON.stringify(claims)))}`;

  const signingKey = await importVapidSigningKey(vapid);
  // Web Crypto ECDSA returns the raw r||s pair (IEEE P1363) — exactly JWS ES256.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, encoder.encode(signingInput)),
  );
  return `${signingInput}.${bytesToBase64url(signature)}`;
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Encrypt and POST one notification to a single subscription's endpoint.
 * Never throws on transport/HTTP errors — returns a structured result so the
 * dispatcher can prune expired subscriptions and continue the fan-out.
 */
export async function sendWebPush(
  subscription: StoredPushSubscription,
  payloadJson: string,
  vapid: VapidKeys,
  ttlSeconds = 2_419_200,
): Promise<WebPushResult> {
  try {
    const body = await encryptPayload(
      encoder.encode(payloadJson),
      base64urlToBytes(subscription.p256dh),
      base64urlToBytes(subscription.auth),
    );
    const jwt = await createVapidJwt(subscription.endpoint, vapid);

    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttlSeconds),
        Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
      },
      // `body` is a Uint8Array; cast to BodyInit for the cross-runtime fetch types.
      body: body as unknown as BodyInit,
    });

    return {
      ok: res.ok,
      status: res.status,
      expired: res.status === 404 || res.status === 410,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      expired: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Read VAPID config from a loose env bag. Returns null when unconfigured. */
export function readVapidKeys(env: Record<string, string | undefined>): VapidKeys | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject: env.VAPID_SUBJECT || 'mailto:admin@lumibase.local',
  };
}
