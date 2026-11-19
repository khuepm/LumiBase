/**
 * Mux adapter (#871). Mux pulls the original from the short-lived source URL,
 * encodes an adaptive HLS ladder and serves posters from `image.mux.com`.
 * Signed playback uses an RS256 JWT minted locally with a Mux signing key
 * (Web Crypto, so it runs on Workers and Node alike).
 *
 * Webhook signature: `Mux-Signature: t=<unix>,v1=<hex>` where
 * `v1 = HMAC-SHA256(secret, "<t>.<body>")`.
 */
import {
  finiteOrUndefined,
  providerJson,
  verifyTimestampedHmac,
  VideoProviderError,
  type FetchLike,
  type PlaybackTarget,
  type PlaybackUrls,
  type ProviderAssetStatus,
  type SubmitInput,
  type SubmitResult,
  type VideoProvider,
  type VideoRendition,
  type VideoWebhookEvent,
} from './provider';

export interface MuxConfig {
  tokenId: string;
  tokenSecret: string;
  webhookSecret: string;
  /** Signing key id + base64 PEM private key, for signed playback. */
  signingKeyId?: string;
  signingKeyPrivate?: string;
  apiBase?: string;
  fetch?: FetchLike;
}

interface MuxAsset {
  id?: string;
  status?: string;
  duration?: number;
  passthrough?: string;
  playback_ids?: Array<{ id?: string; policy?: string }>;
  tracks?: Array<{ type?: string; max_width?: number; max_height?: number }>;
  static_renditions?: { files?: Array<{ width?: number; height?: number; bitrate?: number }> };
  errors?: { type?: string; messages?: string[] };
}

export function muxAssetStatus(a: MuxAsset): ProviderAssetStatus {
  if (a.status === 'errored') {
    return { state: 'failed', error: a.errors?.messages?.join('; ') || a.errors?.type || 'Mux reported an error.' };
  }
  if (a.status !== 'ready') return { state: 'processing' };
  const video = a.tracks?.find((t) => t.type === 'video');
  const renditions: VideoRendition[] = (a.static_renditions?.files ?? [])
    .filter((f) => finiteOrUndefined(f.width) && finiteOrUndefined(f.height))
    .map((f) => ({ width: f.width!, height: f.height!, ...(finiteOrUndefined(f.bitrate) ? { bitrate: f.bitrate } : {}) }));
  const duration = finiteOrUndefined(a.duration);
  return {
    state: 'ready',
    playbackId: a.playback_ids?.[0]?.id,
    durationMs: duration !== undefined ? Math.round(duration * 1000) : undefined,
    width: finiteOrUndefined(video?.max_width),
    height: finiteOrUndefined(video?.max_height),
    renditions,
  };
}

// --- RS256 JWT (Web Crypto) ------------------------------------------------

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64url(json: unknown): string {
  return b64urlFromBytes(new TextEncoder().encode(JSON.stringify(json)));
}

function bytesFromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo (Web Crypto only imports PKCS#8). */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const body = [0x02, 0x01, 0x00, ...algorithm, ...octet];
  const total = body.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(total), ...body, ...pkcs1]);
  return out;
}

/** Accepts the Mux download (base64 of a PEM) or a raw PEM, PKCS#1 or PKCS#8. */
export function privateKeyDer(input: string): Uint8Array<ArrayBuffer> {
  let pem = input.trim();
  if (!pem.includes('-----BEGIN')) pem = new TextDecoder().decode(bytesFromB64(pem));
  const m = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(pem);
  if (!m) throw new VideoProviderError('MUX_SIGNING_KEY_PRIVATE is not a PEM private key.');
  const der = bytesFromB64(m[2]!);
  return m[1] === 'RSA PRIVATE KEY' ? pkcs1ToPkcs8(der) : der;
}

export async function signRs256Jwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
): Promise<string> {
  const input = `${b64url({ alg: 'RS256', typ: 'JWT', ...header })}.${b64url(claims)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input));
  return `${input}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

export class MuxProvider implements VideoProvider {
  readonly name = 'mux';
  private readonly fetch: FetchLike;
  private readonly base: string;
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private readonly cfg: MuxConfig) {
    this.fetch = cfg.fetch ?? ((input, init) => fetch(input, init));
    this.base = `${(cfg.apiBase ?? 'https://api.mux.com').replace(/\/$/, '')}/video/v1/assets`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Basic ${btoa(`${this.cfg.tokenId}:${this.cfg.tokenSecret}`)}`, 'Content-Type': 'application/json' };
  }

  private async call<T>(path: string, init: RequestInit, what: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, { ...init, headers: this.headers() });
    } catch (err) {
      throw new VideoProviderError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = await providerJson<{ data?: T }>(res, what);
    if (body.data === undefined) throw new VideoProviderError(`${what} failed: no data`);
    return body.data;
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const asset = await this.call<MuxAsset>(
      '',
      {
        method: 'POST',
        body: JSON.stringify({
          input: [{ url: input.sourceUrl }],
          playback_policy: [input.signedPlayback ? 'signed' : 'public'],
          passthrough: input.passthrough,
        }),
      },
      'Mux create asset',
    );
    if (!asset.id) throw new VideoProviderError('Mux create asset returned no id.');
    const playbackId = asset.playback_ids?.[0]?.id;
    return { providerAssetId: asset.id, ...(playbackId ? { playbackId } : {}) };
  }

  async status(providerAssetId: string): Promise<ProviderAssetStatus> {
    return muxAssetStatus(await this.call<MuxAsset>(`/${encodeURIComponent(providerAssetId)}`, { method: 'GET' }, 'Mux asset status'));
  }

  async verifyWebhook(rawBody: string, headers: Headers, now: Date): Promise<VideoWebhookEvent | null> {
    await verifyTimestampedHmac({
      secret: this.cfg.webhookSecret,
      rawBody,
      header: headers.get('mux-signature'),
      timestampKey: 't',
      signatureKey: 'v1',
      now,
    });
    const event = JSON.parse(rawBody) as { type?: string; data?: MuxAsset };
    if (!event.type?.startsWith('video.asset.') || !event.data?.id) return null;
    if (!['video.asset.ready', 'video.asset.errored'].includes(event.type)) return null;
    return {
      providerAssetId: event.data.id,
      passthrough: typeof event.data.passthrough === 'string' ? event.data.passthrough : null,
      status: muxAssetStatus(event.data),
    };
  }

  private signingKey(): Promise<CryptoKey> {
    if (!this.cfg.signingKeyId || !this.cfg.signingKeyPrivate) {
      return Promise.reject(new VideoProviderError('Signed playback needs MUX_SIGNING_KEY_ID and MUX_SIGNING_KEY_PRIVATE.'));
    }
    this.keyPromise ??= crypto.subtle.importKey(
      'pkcs8',
      privateKeyDer(this.cfg.signingKeyPrivate),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return this.keyPromise;
  }

  async playback(target: PlaybackTarget, expiresAt: Date): Promise<PlaybackUrls> {
    const playbackId = target.playbackId;
    if (!playbackId) throw new VideoProviderError('The Mux asset has no playback id.');
    const id = encodeURIComponent(playbackId);
    if (!target.signed) {
      return { hls: `https://stream.mux.com/${id}.m3u8`, poster: `https://image.mux.com/${id}/thumbnail.jpg`, expiresAt: null };
    }
    const key = await this.signingKey();
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const kid = this.cfg.signingKeyId!;
    const [video, thumb] = await Promise.all([
      signRs256Jwt({ kid }, { sub: playbackId, aud: 'v', exp, kid }, key),
      signRs256Jwt({ kid }, { sub: playbackId, aud: 't', exp, kid }, key),
    ]);
    return {
      hls: `https://stream.mux.com/${id}.m3u8?token=${video}`,
      poster: `https://image.mux.com/${id}/thumbnail.jpg?token=${thumb}`,
      expiresAt,
    };
  }

  async remove(providerAssetId: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/${encodeURIComponent(providerAssetId)}`, { method: 'DELETE', headers: this.headers() });
    } catch (err) {
      throw new VideoProviderError(`Mux delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok && res.status !== 404) throw new VideoProviderError(`Mux delete failed: HTTP ${res.status}`, res.status);
  }
}
