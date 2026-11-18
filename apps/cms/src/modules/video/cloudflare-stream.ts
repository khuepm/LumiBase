/**
 * Cloudflare Stream adapter (#871). Stream pulls the original from the
 * short-lived source URL (`/stream/copy`), encodes an adaptive HLS ladder
 * and a thumbnail, and calls the account webhook when the video is ready or
 * errored. Signed playback uses Stream's token endpoint, so no signing key
 * has to be held by the CMS.
 *
 * Webhook signature: `Webhook-Signature: time=<unix>,sig1=<hex>` where
 * `sig1 = HMAC-SHA256(secret, "<time>.<body>")`.
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
  type VideoWebhookEvent,
} from './provider';

export interface CloudflareStreamConfig {
  accountId: string;
  apiToken: string;
  /** Secret returned when the account webhook was registered. */
  webhookSecret: string;
  /** Playback host, e.g. `customer-abc123.cloudflarestream.com`. */
  customerDomain: string;
  apiBase?: string;
  fetch?: FetchLike;
}

interface StreamVideo {
  uid?: string;
  readyToStream?: boolean;
  status?: { state?: string; errReasonCode?: string; errReasonText?: string };
  duration?: number;
  input?: { width?: number; height?: number };
  meta?: Record<string, unknown>;
}

interface StreamEnvelope<T> {
  success?: boolean;
  result?: T;
  errors?: Array<{ message?: string }>;
}

export function streamVideoStatus(v: StreamVideo): ProviderAssetStatus {
  const state = v.status?.state;
  if (state === 'error') {
    return { state: 'failed', error: v.status?.errReasonText || v.status?.errReasonCode || 'Cloudflare Stream reported an error.' };
  }
  if (state === 'ready' && v.readyToStream !== false) {
    const duration = finiteOrUndefined(v.duration);
    return {
      state: 'ready',
      durationMs: duration !== undefined ? Math.round(duration * 1000) : undefined,
      width: finiteOrUndefined(v.input?.width),
      height: finiteOrUndefined(v.input?.height),
      // Stream encodes its own adaptive ladder and does not list it.
      renditions: [],
    };
  }
  return { state: 'processing' };
}

export class CloudflareStreamProvider implements VideoProvider {
  readonly name = 'cloudflare-stream';
  private readonly fetch: FetchLike;
  private readonly base: string;

  constructor(private readonly cfg: CloudflareStreamConfig) {
    this.fetch = cfg.fetch ?? ((input, init) => fetch(input, init));
    this.base = `${(cfg.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/$/, '')}/accounts/${encodeURIComponent(cfg.accountId)}/stream`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.apiToken}`, 'Content-Type': 'application/json' };
  }

  private async call<T>(path: string, init: RequestInit, what: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, { ...init, headers: this.headers() });
    } catch (err) {
      throw new VideoProviderError(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const body = await providerJson<StreamEnvelope<T>>(res, what);
    if (body.success === false || body.result === undefined) {
      throw new VideoProviderError(`${what} failed: ${body.errors?.map((e) => e.message).join('; ') || 'no result'}`);
    }
    return body.result;
  }

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const video = await this.call<StreamVideo>(
      '/copy',
      {
        method: 'POST',
        body: JSON.stringify({
          url: input.sourceUrl,
          requireSignedURLs: input.signedPlayback,
          meta: { name: input.name ?? input.passthrough, passthrough: input.passthrough },
        }),
      },
      'Cloudflare Stream copy',
    );
    if (!video.uid) throw new VideoProviderError('Cloudflare Stream copy returned no uid.');
    return { providerAssetId: video.uid };
  }

  async status(providerAssetId: string): Promise<ProviderAssetStatus> {
    return streamVideoStatus(
      await this.call<StreamVideo>(`/${encodeURIComponent(providerAssetId)}`, { method: 'GET' }, 'Cloudflare Stream status'),
    );
  }

  async verifyWebhook(rawBody: string, headers: Headers, now: Date): Promise<VideoWebhookEvent | null> {
    await verifyTimestampedHmac({
      secret: this.cfg.webhookSecret,
      rawBody,
      header: headers.get('webhook-signature'),
      timestampKey: 'time',
      signatureKey: 'sig1',
      now,
    });
    const video = JSON.parse(rawBody) as StreamVideo;
    if (!video.uid) return null;
    const passthrough = typeof video.meta?.passthrough === 'string' ? video.meta.passthrough : null;
    return { providerAssetId: video.uid, passthrough, status: streamVideoStatus(video) };
  }

  async playback(target: PlaybackTarget, expiresAt: Date): Promise<PlaybackUrls> {
    let id = target.providerAssetId;
    let exp: Date | null = null;
    if (target.signed) {
      const res = await this.call<{ token?: string }>(
        `/${encodeURIComponent(target.providerAssetId)}/token`,
        { method: 'POST', body: JSON.stringify({ exp: Math.floor(expiresAt.getTime() / 1000) }) },
        'Cloudflare Stream token',
      );
      if (!res.token) throw new VideoProviderError('Cloudflare Stream token returned no token.');
      id = res.token;
      exp = expiresAt;
    }
    const host = `https://${this.cfg.customerDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
    return {
      hls: `${host}/${encodeURIComponent(id)}/manifest/video.m3u8`,
      poster: `${host}/${encodeURIComponent(id)}/thumbnails/thumbnail.jpg`,
      expiresAt: exp,
    };
  }

  async remove(providerAssetId: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}/${encodeURIComponent(providerAssetId)}`, { method: 'DELETE', headers: this.headers() });
    } catch (err) {
      throw new VideoProviderError(`Cloudflare Stream delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok && res.status !== 404) throw new VideoProviderError(`Cloudflare Stream delete failed: HTTP ${res.status}`, res.status);
  }
}
