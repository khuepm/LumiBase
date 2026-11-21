/**
 * API key token generation — extracted from the api-keys route so both the
 * route and the governed AI skill (`createApiKey`/`rotateApiKey`) issue tokens
 * identically. Web Crypto only (works on both Workers and Node ≥20).
 */

import { PUBLISHABLE_TOKEN_PREFIX, ORGANIZATION_TOKEN_PREFIX } from '@lumibase/contracts';

export interface PlaintextToken {
  /** Full plaintext token — returned to the caller exactly once. */
  token: string;
  /** Stable prefix stored for display/lookup. */
  prefix: string;
  /** SHA-256 hex of the token; only the hash is persisted. */
  tokenHash: string;
}

export interface CreateTokenOptions {
  /**
   * Mint a client-embeddable token (`lbk_pub_…`) instead of a secret one.
   *
   * The prefix is the source of truth for whether a key is publishable — it is
   * derived from the token itself, so it cannot drift from a metadata flag.
   * See `services/api-key-publishable.ts`.
   */
  publishable?: boolean;
  scope?: 'site' | 'organization';
}

export async function createPlaintextToken(
  options: CreateTokenOptions = {},
): Promise<PlaintextToken> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = base64Url(bytes);
  // Secret keys keep the bare `lbk_` prefix so existing tokens stay valid.
  if (options.scope === 'organization' && options.publishable) throw new Error('Organization keys cannot be publishable');
  const token = options.scope === 'organization' ? `${ORGANIZATION_TOKEN_PREFIX}${secret}` : options.publishable ? `${PUBLISHABLE_TOKEN_PREFIX}${secret}` : `lbk_${secret}`;
  return {
    token,
    prefix: token.slice(0, 16),
    tokenHash: await sha256Hex(token),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Env knob for the default lifetime of a new API key, in days (#994). */
export const API_KEY_DEFAULT_TTL_DAYS_ENV = 'API_KEY_DEFAULT_TTL_DAYS';
export const DEFAULT_API_KEY_TTL_DAYS = 90;

/**
 * Expiry for a new API key (#994). An explicit value wins: a date, or `null`
 * for a key that never expires (an opt-in, not the default). When the caller
 * says nothing, the key expires after `API_KEY_DEFAULT_TTL_DAYS` (default 90;
 * `0` restores the old never-expires default) — a forgotten credential then
 * stops working on its own instead of staying valid forever.
 */
export function apiKeyExpiry(
  requested: Date | string | null | undefined,
  env?: Readonly<Record<string, unknown>>,
  now = new Date(),
): Date | null {
  if (requested === null) return null;
  if (requested !== undefined) return requested instanceof Date ? requested : new Date(requested);
  const raw = env?.[API_KEY_DEFAULT_TTL_DAYS_ENV] ?? (typeof process !== 'undefined' ? process.env[API_KEY_DEFAULT_TTL_DAYS_ENV] : undefined);
  const parsed = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : DEFAULT_API_KEY_TTL_DAYS;
  const days = Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 3650) : DEFAULT_API_KEY_TTL_DAYS;
  if (days === 0) return null;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
