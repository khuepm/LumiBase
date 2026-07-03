#!/usr/bin/env node
/**
 * Generate a VAPID key pair for Web Push (push-noti feature).
 *
 * Emits the three env vars the CMS reads (see `modules/notifications/web-push.ts`
 * and `routes/push.ts`):
 *   - VAPID_PUBLIC_KEY   base64url of the raw 65-byte P-256 public point
 *                        (the browser's `applicationServerKey`).
 *   - VAPID_PRIVATE_KEY  base64url of the 32-byte private scalar `d`.
 *   - VAPID_SUBJECT      contact URI; pass one as the first arg, else a default.
 *
 * Usage:
 *   node scripts/generate-vapid-keys.mjs [mailto:you@example.com]
 *
 * The keys never touch disk — copy them into your secret store
 * (`wrangler secret put VAPID_PRIVATE_KEY` on Cloudflare, or the Docker env).
 * Uses only the Web Crypto API, so no extra dependencies.
 */

const subject = process.argv[2] || 'mailto:admin@example.com';

const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const bytesToBase64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

const publicKey = bytesToBase64url(publicRaw);
const privateKey = jwk.d; // already base64url per JWK spec

console.log('# VAPID keys for LumiBase Web Push — store these as secrets.');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=${subject}`);
