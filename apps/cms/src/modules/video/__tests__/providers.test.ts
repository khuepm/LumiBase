/**
 * Provider adapters (#871) against a recorded fetch: request shapes, status
 * mapping, webhook signature checks (valid, forged, replayed, rotated keys),
 * and signed playback (Stream token endpoint; Mux RS256 JWT verified with the
 * public half of a generated key, in both PKCS#1 and PKCS#8 form).
 */
import { describe, expect, it } from 'vitest';
import { CloudflareStreamProvider, streamVideoStatus } from '../cloudflare-stream';
import { videoProviderFromEnv } from '../config';
import { MuxProvider, muxAssetStatus, pkcs1ToPkcs8 } from '../mux';
import { hmacSha256Hex, VideoProviderError, VideoWebhookError } from '../provider';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recorder(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const NOW = new Date('2026-11-18T10:00:00Z');
const ts = Math.floor(NOW.getTime() / 1000);

describe('Cloudflare Stream adapter', () => {
  const cfg = { accountId: 'acc', apiToken: 'tok', webhookSecret: 'whsec', customerDomain: 'customer-abc.cloudflarestream.com' };

  it('submits a copy-from-URL with the passthrough and signed-URL flag', async () => {
    const r = recorder(() => json({ success: true, result: { uid: 'uid1' } }));
    const p = new CloudflareStreamProvider({ ...cfg, fetch: r.fetch });
    expect(await p.submit({ sourceUrl: 'https://cms/src', passthrough: 's:f:1', signedPlayback: true, name: 'a.mp4' })).toEqual({ providerAssetId: 'uid1' });
    expect(r.calls[0]).toMatchObject({
      url: 'https://api.cloudflare.com/client/v4/accounts/acc/stream/copy',
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { url: 'https://cms/src', requireSignedURLs: true, meta: { name: 'a.mp4', passthrough: 's:f:1' } },
    });
  });

  it('maps states, and errors become retryable provider errors', async () => {
    expect(streamVideoStatus({ status: { state: 'inprogress' } })).toEqual({ state: 'processing' });
    expect(streamVideoStatus({ status: { state: 'error', errReasonText: 'bad codec' } })).toEqual({ state: 'failed', error: 'bad codec' });
    expect(streamVideoStatus({ status: { state: 'ready' }, readyToStream: true, duration: 12.345, input: { width: 1920, height: 1080 } })).toEqual({
      state: 'ready',
      durationMs: 12345,
      width: 1920,
      height: 1080,
      renditions: [],
    });
    const p = new CloudflareStreamProvider({ ...cfg, fetch: recorder(() => json({ success: false, errors: [{ message: 'nope' }] }, 500)).fetch });
    await expect(p.status('uid1')).rejects.toBeInstanceOf(VideoProviderError);
  });

  it('verifies `time=…,sig1=…` and rejects forged or replayed webhooks', async () => {
    const p = new CloudflareStreamProvider(cfg);
    const body = JSON.stringify({ uid: 'uid1', readyToStream: true, status: { state: 'ready' }, meta: { passthrough: 's:f:1' }, duration: 3 });
    const sig = await hmacSha256Hex('whsec', `${ts}.${body}`);
    const ok = await p.verifyWebhook(body, new Headers({ 'Webhook-Signature': `time=${ts},sig1=${sig}` }), NOW);
    expect(ok).toMatchObject({ providerAssetId: 'uid1', passthrough: 's:f:1', status: { state: 'ready', durationMs: 3000 } });
    await expect(p.verifyWebhook(body, new Headers({ 'Webhook-Signature': `time=${ts},sig1=${'0'.repeat(64)}` }), NOW)).rejects.toBeInstanceOf(VideoWebhookError);
    await expect(p.verifyWebhook(body.replace('s:f:1', 's:f:2'), new Headers({ 'Webhook-Signature': `time=${ts},sig1=${sig}` }), NOW)).rejects.toBeInstanceOf(VideoWebhookError);
    const late = new Date(NOW.getTime() + 6 * 60 * 1000);
    await expect(p.verifyWebhook(body, new Headers({ 'Webhook-Signature': `time=${ts},sig1=${sig}` }), late)).rejects.toThrow(/tolerance/);
    await expect(p.verifyWebhook(body, new Headers(), NOW)).rejects.toThrow(/Missing/);
  });

  it('signed playback swaps the uid for a token from the token endpoint', async () => {
    const r = recorder(() => json({ success: true, result: { token: 'tkn' } }));
    const p = new CloudflareStreamProvider({ ...cfg, fetch: r.fetch });
    const exp = new Date(NOW.getTime() + 3600_000);
    const urls = await p.playback({ providerAssetId: 'uid1', playbackId: null, signed: true }, exp);
    expect(urls).toEqual({
      hls: 'https://customer-abc.cloudflarestream.com/tkn/manifest/video.m3u8',
      poster: 'https://customer-abc.cloudflarestream.com/tkn/thumbnails/thumbnail.jpg',
      expiresAt: exp,
    });
    expect(r.calls[0]).toMatchObject({ url: expect.stringMatching(/\/stream\/uid1\/token$/), method: 'POST', body: { exp: Math.floor(exp.getTime() / 1000) } });
    const open = await p.playback({ providerAssetId: 'uid1', playbackId: null, signed: false }, exp);
    expect(open.hls).toBe('https://customer-abc.cloudflarestream.com/uid1/manifest/video.m3u8');
    expect(open.expiresAt).toBeNull();
  });

  it('remove tolerates an already-deleted asset', async () => {
    const p = new CloudflareStreamProvider({ ...cfg, fetch: recorder(() => new Response(null, { status: 404 })).fetch });
    await expect(p.remove('gone')).resolves.toBeUndefined();
  });
});

async function rsaKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { pair, pkcs8 };
}

const pem = (label: string, der: Uint8Array) => {
  let bin = '';
  for (const b of der) bin += String.fromCharCode(b);
  return `-----BEGIN ${label}-----\n${btoa(bin).replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n`;
};

/** The PKCS#1 key is the content of the PKCS#8 OCTET STRING (last element). */
function pkcs1Of(pkcs8: Uint8Array): Uint8Array {
  // 30 82 LL LL | 02 01 00 | 30 0d …(15) | 04 82 LL LL | <pkcs1>
  const octetAt = 4 + 3 + 15;
  expect(pkcs8[octetAt]).toBe(0x04);
  const len = (pkcs8[octetAt + 2]! << 8) | pkcs8[octetAt + 3]!;
  return pkcs8.slice(octetAt + 4, octetAt + 4 + len);
}

async function verifyJwt(token: string, publicKey: CryptoKey) {
  const [h, p, s] = token.split('.');
  const dec = (x: string) => Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (x.length % 4)) % 4)), (ch) => ch.charCodeAt(0));
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, dec(s!), new TextEncoder().encode(`${h}.${p}`));
  return { ok, header: JSON.parse(new TextDecoder().decode(dec(h!))), claims: JSON.parse(new TextDecoder().decode(dec(p!))) };
}

describe('Mux adapter', () => {
  const base = { tokenId: 'id', tokenSecret: 'secret', webhookSecret: 'mwh' };

  it('creates an asset from the source URL with basic auth and the playback policy', async () => {
    const r = recorder(() => json({ data: { id: 'asset1', status: 'preparing', playback_ids: [{ id: 'pb1', policy: 'signed' }] } }, 201));
    const p = new MuxProvider({ ...base, fetch: r.fetch });
    expect(await p.submit({ sourceUrl: 'https://cms/src', passthrough: 's:f:2', signedPlayback: true })).toEqual({ providerAssetId: 'asset1', playbackId: 'pb1' });
    expect(r.calls[0]).toMatchObject({
      url: 'https://api.mux.com/video/v1/assets',
      headers: { authorization: `Basic ${btoa('id:secret')}` },
      body: { input: [{ url: 'https://cms/src' }], playback_policy: ['signed'], passthrough: 's:f:2' },
    });
  });

  it('maps asset states, including static renditions', () => {
    expect(muxAssetStatus({ status: 'preparing' })).toEqual({ state: 'processing' });
    expect(muxAssetStatus({ status: 'errored', errors: { messages: ['input unreadable'] } })).toEqual({ state: 'failed', error: 'input unreadable' });
    expect(
      muxAssetStatus({
        status: 'ready',
        duration: 61.5,
        playback_ids: [{ id: 'pb1' }],
        tracks: [{ type: 'audio' }, { type: 'video', max_width: 1280, max_height: 720 }],
        static_renditions: { files: [{ width: 640, height: 360, bitrate: 800_000 }, { width: 0, height: 0 }] },
      }),
    ).toEqual({ state: 'ready', playbackId: 'pb1', durationMs: 61500, width: 1280, height: 720, renditions: [{ width: 640, height: 360, bitrate: 800_000 }] });
  });

  it('verifies `t=…,v1=…` (any of several v1 values) and only acts on ready/errored', async () => {
    const p = new MuxProvider(base);
    const body = JSON.stringify({ type: 'video.asset.ready', data: { id: 'asset1', status: 'ready', passthrough: 's:f:2', playback_ids: [{ id: 'pb1' }] } });
    const sig = await hmacSha256Hex('mwh', `${ts}.${body}`);
    const header = new Headers({ 'Mux-Signature': `t=${ts},v1=${'a'.repeat(64)},v1=${sig}` });
    expect(await p.verifyWebhook(body, header, NOW)).toMatchObject({ providerAssetId: 'asset1', passthrough: 's:f:2', status: { state: 'ready', playbackId: 'pb1' } });
    const created = JSON.stringify({ type: 'video.asset.created', data: { id: 'asset1' } });
    const sig2 = await hmacSha256Hex('mwh', `${ts}.${created}`);
    expect(await p.verifyWebhook(created, new Headers({ 'Mux-Signature': `t=${ts},v1=${sig2}` }), NOW)).toBeNull();
    await expect(p.verifyWebhook(body, new Headers({ 'Mux-Signature': `t=${ts},v1=${sig2}` }), NOW)).rejects.toBeInstanceOf(VideoWebhookError);
  });

  it('signs playback with an RS256 JWT per audience, from a PKCS#1 or PKCS#8 key', async () => {
    const { pair, pkcs8 } = await rsaKeys();
    const pkcs1 = pkcs1Of(pkcs8);
    expect([...pkcs1ToPkcs8(pkcs1)]).toEqual([...pkcs8]);
    const exp = new Date(NOW.getTime() + 3600_000);
    for (const key of [btoa(pem('RSA PRIVATE KEY', pkcs1)), pem('PRIVATE KEY', pkcs8)]) {
      const p = new MuxProvider({ ...base, signingKeyId: 'kid1', signingKeyPrivate: key });
      const urls = await p.playback({ providerAssetId: 'asset1', playbackId: 'pb1', signed: true }, exp);
      expect(urls.expiresAt).toEqual(exp);
      const video = await verifyJwt(new URL(urls.hls).searchParams.get('token')!, pair.publicKey);
      const thumb = await verifyJwt(new URL(urls.poster!).searchParams.get('token')!, pair.publicKey);
      expect(urls.hls.startsWith('https://stream.mux.com/pb1.m3u8?token=')).toBe(true);
      expect(video).toMatchObject({ ok: true, header: { alg: 'RS256', kid: 'kid1' }, claims: { sub: 'pb1', aud: 'v', exp: Math.floor(exp.getTime() / 1000) } });
      expect(thumb).toMatchObject({ ok: true, claims: { sub: 'pb1', aud: 't' } });
    }
  });

  it('public playback needs no key; signed playback without one is a provider error', async () => {
    const p = new MuxProvider(base);
    expect(await p.playback({ providerAssetId: 'a', playbackId: 'pb1', signed: false }, NOW)).toEqual({
      hls: 'https://stream.mux.com/pb1.m3u8',
      poster: 'https://image.mux.com/pb1/thumbnail.jpg',
      expiresAt: null,
    });
    await expect(p.playback({ providerAssetId: 'a', playbackId: 'pb1', signed: true }, NOW)).rejects.toBeInstanceOf(VideoProviderError);
  });
});

describe('videoProviderFromEnv', () => {
  it('builds the configured adapter only when its credentials are complete', () => {
    expect(videoProviderFromEnv({})).toBeNull();
    expect(videoProviderFromEnv({ VIDEO_PROVIDER: 'mux', MUX_TOKEN_ID: 'a' })).toBeNull();
    expect(videoProviderFromEnv({ VIDEO_PROVIDER: 'mux', MUX_TOKEN_ID: 'a', MUX_TOKEN_SECRET: 'b', MUX_WEBHOOK_SECRET: 'c' })?.name).toBe('mux');
    expect(
      videoProviderFromEnv({
        VIDEO_PROVIDER: 'cloudflare-stream',
        CF_STREAM_ACCOUNT_ID: 'a',
        CF_STREAM_API_TOKEN: 'b',
        CF_STREAM_WEBHOOK_SECRET: 'c',
        CF_STREAM_CUSTOMER_DOMAIN: 'customer-x.cloudflarestream.com',
      })?.name,
    ).toBe('cloudflare-stream');
    expect(videoProviderFromEnv({ VIDEO_PROVIDER: 'ffmpeg' })).toBeNull();
  });
});
