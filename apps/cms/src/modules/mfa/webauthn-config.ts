/**
 * Relying-party (RP) configuration for passkeys (#735).
 *
 * A passkey is bound by the browser to an **RP ID** (a registrable domain) and
 * every assertion carries the page **origin** that produced it. Both must be
 * the Studio's — not the API's — because the ceremony runs in the Studio page.
 *
 * Resolution, in order:
 *
 *   1. `WEBAUTHN_ORIGINS` (comma-separated) — the exact Studio origins allowed
 *      to run ceremonies. `WEBAUTHN_RP_ID` defaults to the host of the origin
 *      the request came from (or the first listed origin).
 *   2. Neither set — the request's `Origin` header, **only** when it is already
 *      trusted: same origin as the API, equal to `LUMIBASE_PUBLIC_URL`, or
 *      accepted by the credentialed-CORS rule (`CORS_ALLOWED_ORIGINS`, or a
 *      loopback origin outside production). The RP ID is its host.
 *
 * Every origin must be `https:` (or `http:` on a loopback host) and its host
 * must equal the RP ID or be a subdomain of it — the same rule browsers apply.
 * Anything else (including the desktop shell's `tauri://localhost`, where
 * WebAuthn is not offered) resolves to "not configured" and the endpoints
 * answer `503 WEBAUTHN_NOT_CONFIGURED`: fail closed, never guess.
 */

import { parseAllowedOrigins, resolveCorsOrigin } from '../../config/cors';

export interface WebAuthnRp {
  rpId: string;
  rpName: string;
  /** Origins accepted in `clientDataJSON.origin`. */
  origins: string[];
}

export interface WebAuthnEnv {
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_RP_NAME?: string;
  WEBAUTHN_ORIGINS?: string;
  CORS_ALLOWED_ORIGINS?: string;
  LUMIBASE_PUBLIC_URL?: string;
  LUMIBASE_ENV?: string;
}

export const DEFAULT_RP_NAME = 'LumiBase';

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function normalizeOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function hostOf(origin: string): string {
  return new URL(origin).hostname;
}

/** WebAuthn's RP ID rule: the origin's host is the RP ID or a subdomain of it. */
export function originMatchesRpId(origin: string, rpId: string): boolean {
  const host = hostOf(origin);
  return host === rpId || host.endsWith(`.${rpId}`);
}

function trustedRequestOrigin(env: WebAuthnEnv, requestUrl: string, origin: string | undefined): string | null {
  if (!origin) return null;
  const normalized = normalizeOrigin(origin);
  if (!normalized || normalized !== origin.replace(/\/+$/, '')) return null;
  try {
    if (new URL(requestUrl).origin === normalized) return normalized;
  } catch {
    // fall through
  }
  if (env.LUMIBASE_PUBLIC_URL) {
    const pub = normalizeOrigin(env.LUMIBASE_PUBLIC_URL);
    if (pub && pub === normalized) return normalized;
  }
  const cors = resolveCorsOrigin(normalized, {
    CORS_ALLOWED_ORIGINS: env.CORS_ALLOWED_ORIGINS,
    // Same reading as the CORS middleware: loopback is trusted unless the env says production.
    LUMIBASE_ENV: env.LUMIBASE_ENV ?? '',
  });
  return cors === normalized ? normalized : null;
}

export function resolveWebAuthnRp(
  env: WebAuthnEnv,
  requestUrl: string,
  requestOrigin: string | undefined,
): WebAuthnRp | null {
  const rpName = env.WEBAUTHN_RP_NAME?.trim() || DEFAULT_RP_NAME;
  const explicitRpId = env.WEBAUTHN_RP_ID?.trim().toLowerCase() || null;

  let origins: string[];
  let preferred: string | null;
  const configured = parseAllowedOrigins(env.WEBAUTHN_ORIGINS);
  if (configured.length > 0) {
    origins = configured.map(normalizeOrigin).filter((o): o is string => o !== null);
    const req = requestOrigin ? normalizeOrigin(requestOrigin) : null;
    preferred = req && origins.includes(req) ? req : origins[0] ?? null;
  } else {
    preferred = trustedRequestOrigin(env, requestUrl, requestOrigin);
    origins = preferred ? [preferred] : [];
  }
  if (!preferred) return null;

  const rpId = explicitRpId ?? hostOf(preferred);
  const valid = origins.filter((o) => originMatchesRpId(o, rpId));
  if (valid.length === 0) return null;
  return { rpId, rpName, origins: valid };
}

/** Read the WebAuthn knobs from the Worker bindings, falling back to `process.env` (Docker). */
export function webAuthnEnvFrom(bindings: Partial<WebAuthnEnv> | undefined): WebAuthnEnv {
  const pick = (k: keyof WebAuthnEnv): string | undefined =>
    bindings?.[k] ?? (typeof process !== 'undefined' ? process.env[k] : undefined);
  return {
    WEBAUTHN_RP_ID: pick('WEBAUTHN_RP_ID'),
    WEBAUTHN_RP_NAME: pick('WEBAUTHN_RP_NAME'),
    WEBAUTHN_ORIGINS: pick('WEBAUTHN_ORIGINS'),
    CORS_ALLOWED_ORIGINS: pick('CORS_ALLOWED_ORIGINS'),
    LUMIBASE_PUBLIC_URL: pick('LUMIBASE_PUBLIC_URL'),
    LUMIBASE_ENV: pick('LUMIBASE_ENV'),
  };
}
