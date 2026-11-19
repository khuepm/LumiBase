/**
 * Video provider port (#871). Transcoding (renditions + HLS manifest +
 * poster) cannot run in a Worker, so it is delegated to an external service
 * behind this interface. Adapters speak plain HTTP through an injected
 * `fetch`, so the same code runs on Cloudflare Workers and on Node; business
 * logic never names a provider.
 */

export type VideoStatus = 'uploaded' | 'processing' | 'ready' | 'failed';

export const VIDEO_STATUSES: readonly VideoStatus[] = ['uploaded', 'processing', 'ready', 'failed'];

export interface VideoRendition {
  width: number;
  height: number;
  bitrate?: number;
}

/** What the provider says about one asset. */
export type ProviderAssetStatus =
  | { state: 'processing' }
  | {
      state: 'ready';
      playbackId?: string;
      durationMs?: number;
      width?: number;
      height?: number;
      renditions: VideoRendition[];
    }
  | { state: 'failed'; error: string };

export interface SubmitInput {
  /** Short-lived URL the provider pulls the original from. */
  sourceUrl: string;
  /** Opaque `site:file:version` echoed back on webhooks. */
  passthrough: string;
  signedPlayback: boolean;
  /** Display name only. */
  name?: string;
}

export interface SubmitResult {
  providerAssetId: string;
  playbackId?: string;
}

/** A verified webhook from the provider. */
export interface VideoWebhookEvent {
  providerAssetId: string;
  passthrough: string | null;
  status: ProviderAssetStatus;
}

export interface PlaybackTarget {
  providerAssetId: string;
  playbackId: string | null;
  signed: boolean;
}

export interface PlaybackUrls {
  hls: string;
  poster: string | null;
  /** Null when the URLs are not signed (they do not expire). */
  expiresAt: Date | null;
}

export interface VideoProvider {
  /** Stable adapter name stored on the asset row (`cloudflare-stream`, `mux`). */
  readonly name: string;
  submit(input: SubmitInput): Promise<SubmitResult>;
  status(providerAssetId: string): Promise<ProviderAssetStatus>;
  /**
   * Verify the signature and parse the body. Throws {@link VideoWebhookError}
   * on a bad or stale signature; returns null for an event this pipeline does
   * not act on.
   */
  verifyWebhook(rawBody: string, headers: Headers, now: Date): Promise<VideoWebhookEvent | null>;
  playback(target: PlaybackTarget, expiresAt: Date): Promise<PlaybackUrls>;
  remove(providerAssetId: string): Promise<void>;
}

/** The provider was unreachable or refused the call (retryable). */
export class VideoProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VideoProviderError';
  }
}

/** A webhook failed signature verification. */
export class VideoWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VideoWebhookError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Webhooks older or newer than this are rejected (replay window). */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Parse `k=v,k=v` signature headers (`time=…,sig1=…` / `t=…,v1=…`). A key may
 * repeat (key rotation), so values are collected.
 */
export function parseSignatureHeader(header: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    out.set(k, [...(out.get(k) ?? []), v]);
  }
  return out;
}

/** Shared `${timestamp}.${body}` HMAC check used by both adapters. */
export async function verifyTimestampedHmac(opts: {
  secret: string;
  rawBody: string;
  header: string | null;
  timestampKey: string;
  signatureKey: string;
  now: Date;
}): Promise<void> {
  if (!opts.header) throw new VideoWebhookError('Missing signature header.');
  const parts = parseSignatureHeader(opts.header);
  const ts = parts.get(opts.timestampKey)?.[0];
  const sigs = parts.get(opts.signatureKey) ?? [];
  if (!ts || !/^\d+$/.test(ts) || sigs.length === 0) throw new VideoWebhookError('Malformed signature header.');
  if (Math.abs(opts.now.getTime() - Number(ts) * 1000) > WEBHOOK_TOLERANCE_MS) {
    throw new VideoWebhookError('Webhook timestamp outside the tolerance window.');
  }
  const expected = await hmacSha256Hex(opts.secret, `${ts}.${opts.rawBody}`);
  if (!sigs.some((s) => timingSafeEqualHex(s.toLowerCase(), expected))) throw new VideoWebhookError('Invalid signature.');
}

/** Read a JSON response or throw a retryable provider error. */
export async function providerJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new VideoProviderError(`${what} failed: HTTP ${res.status}${detail ? ` ${detail}` : ''}`, res.status);
  }
  return (await res.json()) as T;
}

export function finiteOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}
