import { describe, expect, it } from 'vitest';
import {
  base64urlToBytes,
  bytesToBase64url,
  createVapidJwt,
  encryptPayload,
  readVapidKeys,
  type VapidKeys,
} from '../web-push';

/**
 * Web Push crypto unit tests (push-noti feature). The deterministic pieces are
 * covered here; true end-to-end delivery needs a live push service (FCM/etc.)
 * and so is out of scope for the offline suite.
 */

/** Generate a real VAPID-style key pair via Web Crypto for the JWT test. */
async function generateVapid(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return {
    publicKey: bytesToBase64url(publicRaw as Uint8Array<ArrayBuffer>),
    privateKey: jwk.d!,
    subject: 'mailto:test@lumibase.local',
  };
}

describe('base64url helpers', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 64, 63, 62]);
    const encoded = bytesToBase64url(bytes);
    expect(encoded).not.toMatch(/[+/=]/); // url-safe, unpadded
    expect(Array.from(base64urlToBytes(encoded))).toEqual(Array.from(bytes));
  });

  it('decodes a known base64url string', () => {
    // "hi" => base64 "aGk=" => base64url "aGk"
    expect(new TextDecoder().decode(base64urlToBytes('aGk'))).toBe('hi');
  });
});

describe('readVapidKeys', () => {
  it('returns null when keys are absent', () => {
    expect(readVapidKeys({})).toBeNull();
    expect(readVapidKeys({ VAPID_PUBLIC_KEY: 'x' })).toBeNull();
  });

  it('reads keys and defaults the subject', () => {
    const keys = readVapidKeys({ VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' });
    expect(keys).toEqual({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:admin@lumibase.local' });
  });
});

describe('createVapidJwt', () => {
  it('produces a verifiable ES256 JWT with the endpoint origin as aud', async () => {
    const vapid = await generateVapid();
    const jwt = await createVapidJwt('https://push.example.com/path/abc?x=1', vapid);

    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    expect(headerB64 && payloadB64 && sigB64).toBeTruthy();

    const header = JSON.parse(new TextDecoder().decode(base64urlToBytes(headerB64!)));
    const claims = JSON.parse(new TextDecoder().decode(base64urlToBytes(payloadB64!)));
    expect(header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(claims.aud).toBe('https://push.example.com');
    expect(claims.sub).toBe('mailto:test@lumibase.local');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The signature must verify against the public key (raw r||s, 64 bytes).
    const pub = base64urlToBytes(vapid.publicKey);
    const verifyKey = await crypto.subtle.importKey(
      'raw',
      pub,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifyKey,
      base64urlToBytes(sigB64!),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    expect(ok).toBe(true);
  });
});

describe('encryptPayload (RFC 8291 aes128gcm)', () => {
  it('emits a body whose header carries the salt, record size and server key', async () => {
    // A client subscription keypair: p256dh is the UA public point.
    const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ]);
    const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
    const authSecret = crypto.getRandomValues(new Uint8Array(16));

    const body = await encryptPayload(
      new TextEncoder().encode('{"hello":"world"}'),
      uaPublic as Uint8Array<ArrayBuffer>,
      authSecret,
    );

    // Header is salt(16) + rs(4) + idlen(1) + keyid(65); ciphertext follows.
    expect(body.length).toBeGreaterThan(16 + 4 + 1 + 65);
    const idlen = body[20];
    expect(idlen).toBe(65); // uncompressed P-256 server public key
    const rs = new DataView(body.buffer, body.byteOffset).getUint32(16, false);
    expect(rs).toBe(4096);
    // keyid is a valid uncompressed point (0x04 prefix).
    expect(body[21]).toBe(0x04);
  });
});
