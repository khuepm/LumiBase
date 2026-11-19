/**
 * Deployment-level video configuration (#871). The provider and its
 * credentials are an operator decision, never a tenant one: a site can only
 * switch the pipeline on for itself (`files.dam.video.enabled`).
 */
import { CloudflareStreamProvider } from './cloudflare-stream';
import { MuxProvider } from './mux';
import type { FetchLike, VideoProvider } from './provider';

export const VIDEO_PROVIDERS = ['cloudflare-stream', 'mux'] as const;
export type VideoProviderName = (typeof VIDEO_PROVIDERS)[number];

function str(env: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = env?.[key] ?? (typeof process !== 'undefined' ? process.env?.[key] : undefined);
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Build the configured provider, or null when `VIDEO_PROVIDER` is unset or
 * its required credentials are missing (the pipeline then stays idle and
 * `GET /files/:id/video` reports `VIDEO_PROVIDER_NOT_CONFIGURED`).
 */
export function videoProviderFromEnv(env: Record<string, unknown> | undefined, fetchImpl?: FetchLike): VideoProvider | null {
  const name = str(env, 'VIDEO_PROVIDER');
  if (name === 'cloudflare-stream') {
    const accountId = str(env, 'CF_STREAM_ACCOUNT_ID');
    const apiToken = str(env, 'CF_STREAM_API_TOKEN');
    const webhookSecret = str(env, 'CF_STREAM_WEBHOOK_SECRET');
    const customerDomain = str(env, 'CF_STREAM_CUSTOMER_DOMAIN');
    if (!accountId || !apiToken || !webhookSecret || !customerDomain) return null;
    return new CloudflareStreamProvider({ accountId, apiToken, webhookSecret, customerDomain, fetch: fetchImpl });
  }
  if (name === 'mux') {
    const tokenId = str(env, 'MUX_TOKEN_ID');
    const tokenSecret = str(env, 'MUX_TOKEN_SECRET');
    const webhookSecret = str(env, 'MUX_WEBHOOK_SECRET');
    if (!tokenId || !tokenSecret || !webhookSecret) return null;
    return new MuxProvider({
      tokenId,
      tokenSecret,
      webhookSecret,
      signingKeyId: str(env, 'MUX_SIGNING_KEY_ID'),
      signingKeyPrivate: str(env, 'MUX_SIGNING_KEY_PRIVATE'),
      fetch: fetchImpl,
    });
  }
  return null;
}

/** Public origin the provider pulls sources from (`LUMIBASE_PUBLIC_URL`), if set. */
export function publicOriginFromEnv(env: Record<string, unknown> | undefined): string | null {
  const raw = str(env, 'LUMIBASE_PUBLIC_URL');
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Secret the source-URL signatures derive from (`JWT_SECRET`). */
export function sourceSecretFromEnv(env: Record<string, unknown> | undefined): string | null {
  return str(env, 'JWT_SECRET') ?? null;
}
