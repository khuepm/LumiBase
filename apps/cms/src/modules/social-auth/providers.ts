/**
 * Social login providers (#736): Google and Apple (OpenID Connect) and GitHub
 * (OAuth 2.0 + REST API).
 *
 * Each provider is reduced to two operations:
 *
 *   - {@link buildAuthorizationUrl} — where to send the browser, carrying our
 *     `state`, an OIDC `nonce` and (where the provider supports it) a PKCE
 *     S256 challenge whose verifier never leaves the server.
 *   - {@link resolveProviderProfile} — exchange the `code` at the token
 *     endpoint and turn the answer into a verified {@link SocialProfile}:
 *       * Google / Apple: the ID token is verified with `jose` against the
 *         provider's JWKS (signature, `iss`, `aud` = our client id, `exp`),
 *         then the `nonce` claim is compared in constant time.
 *       * GitHub (no ID token): `/user` for the stable numeric id and
 *         `/user/emails` for the PRIMARY address and whether GitHub verified
 *         it — an unverified or non-primary address is never reported as
 *         verified.
 *
 * Network and key material are injected ({@link ProviderDeps}) so tests run
 * with a mocked `fetch` and a local JWKS; production uses `globalThis.fetch`
 * and `jose.createRemoteJWKSet` (cached per URI).
 */

import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { SocialAuthError } from './errors';
import { timingSafeEqual } from './pkce';

export const SOCIAL_PROVIDERS = ['google', 'apple', 'github'] as const;
export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

export function isSocialProvider(value: unknown): value is SocialProvider {
  return typeof value === 'string' && (SOCIAL_PROVIDERS as readonly string[]).includes(value);
}

interface ProviderSpec {
  authorizeUrl: string;
  tokenUrl: string;
  /** Canonical issuer stored in `user_identities.issuer`. */
  issuer: string;
  /** `iss` values accepted on the ID token (OIDC providers only). */
  acceptedIssuers?: string[];
  jwksUri?: string;
  scope: string;
  /** Apple returns the code via an HTML form POST. */
  responseMode?: 'form_post';
  /** Whether the provider honours RFC 7636 `code_challenge`. */
  pkce: boolean;
  /** OIDC `nonce` replay binding. GitHub is plain OAuth: no ID token, no nonce. */
  nonce: boolean;
}

export const PROVIDER_SPECS: Record<SocialProvider, ProviderSpec> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    issuer: 'https://accounts.google.com',
    acceptedIssuers: ['https://accounts.google.com', 'accounts.google.com'],
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    scope: 'openid email profile',
    pkce: true,
    nonce: true,
  },
  apple: {
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    issuer: 'https://appleid.apple.com',
    acceptedIssuers: ['https://appleid.apple.com'],
    jwksUri: 'https://appleid.apple.com/auth/keys',
    scope: 'name email',
    // Apple requires form_post whenever `name`/`email` scopes are requested.
    responseMode: 'form_post',
    // Sign in with Apple does not document PKCE; the authorization code is
    // bound instead by the client-secret JWT, `state` and the ID-token nonce.
    pkce: false,
    nonce: true,
  },
  github: {
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    issuer: 'https://github.com',
    scope: 'read:user user:email',
    pkce: true,
    nonce: false,
  },
};

const GITHUB_API = 'https://api.github.com';
const APPLE_AUDIENCE = 'https://appleid.apple.com';
const FETCH_TIMEOUT_MS = 10_000;

/** Decrypted provider configuration for one site. */
export interface ProviderRuntimeConfig {
  provider: SocialProvider;
  clientId: string;
  /** Google / GitHub. */
  clientSecret?: string | null;
  /** Apple: team id, key id and the PKCS#8 PEM of the `.p8` key. */
  apple?: { teamId: string; keyId: string; privateKeyPem: string } | null;
}

/** What a provider asserted about the person who signed in. */
export interface SocialProfile {
  provider: SocialProvider;
  issuer: string;
  subject: string;
  email: string | null;
  /** True only when the provider itself asserts the address is verified. */
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  avatar: string | null;
}

export interface ProviderDeps {
  fetch: typeof fetch;
  /** JWKS resolver for an ID token's signing key. */
  jwks: (uri: string) => JWTVerifyGetKey;
}

const remoteJwks = new Map<string, JWTVerifyGetKey>();

export const defaultProviderDeps: ProviderDeps = {
  fetch: (input, init) => globalThis.fetch(input, init),
  jwks: (uri) => {
    let set = remoteJwks.get(uri);
    if (!set) {
      set = createRemoteJWKSet(new URL(uri));
      remoteJwks.set(uri, set);
    }
    return set;
  },
};

export interface AuthorizationParams {
  /** Our callback URL — must equal what is registered at the provider. */
  callbackUri: string;
  state: string;
  nonce: string;
  /** S256 challenge of the server-held verifier (ignored where `pkce` is false). */
  codeChallenge: string;
}

export function buildAuthorizationUrl(cfg: ProviderRuntimeConfig, params: AuthorizationParams): string {
  const spec = PROVIDER_SPECS[cfg.provider];
  const url = new URL(spec.authorizeUrl);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', params.callbackUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', spec.scope);
  url.searchParams.set('state', params.state);
  if (spec.nonce) url.searchParams.set('nonce', params.nonce);
  if (spec.responseMode) url.searchParams.set('response_mode', spec.responseMode);
  if (spec.pkce) {
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  if (cfg.provider === 'google') url.searchParams.set('prompt', 'select_account');
  if (cfg.provider === 'github') url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

export interface CodeExchangeInput {
  code: string;
  callbackUri: string;
  codeVerifier: string;
  nonce: string;
  /**
   * Apple only: the `user` form field Apple posts on the FIRST authorization
   * of this app (`{"name":{"firstName","lastName"},"email"}`). Absent on every
   * later sign-in, which is why the name is persisted the first time.
   */
  appleUser?: string | null;
}

/** Exchange the authorization code and return the verified profile. */
export async function resolveProviderProfile(
  cfg: ProviderRuntimeConfig,
  input: CodeExchangeInput,
  deps: ProviderDeps = defaultProviderDeps,
): Promise<SocialProfile> {
  switch (cfg.provider) {
    case 'google':
      return resolveGoogle(cfg, input, deps);
    case 'apple':
      return resolveApple(cfg, input, deps);
    case 'github':
      return resolveGithub(cfg, input, deps);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function upstreamError(message: string): SocialAuthError {
  return new SocialAuthError('SOCIAL_PROVIDER_ERROR', 502, message);
}

async function postForm(deps: ProviderDeps, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw upstreamError('The sign-in provider could not be reached.');
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // GitHub answers 200 with `{ error }` for a bad code; treat both alike.
  if (!res.ok || !body || typeof body.error === 'string') {
    throw new SocialAuthError(
      'SOCIAL_CODE_REJECTED',
      401,
      'The sign-in provider rejected the authorization code. Start the sign-in again.',
    );
  }
  return body;
}

function claimString(payload: JWTPayload, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** OIDC `email_verified` is a boolean; Apple has sent it as the string "true". */
export function claimTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

async function verifyIdToken(
  cfg: ProviderRuntimeConfig,
  idToken: unknown,
  nonce: string,
  deps: ProviderDeps,
): Promise<JWTPayload> {
  const spec = PROVIDER_SPECS[cfg.provider];
  if (typeof idToken !== 'string' || !idToken) throw upstreamError('The provider returned no ID token.');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, deps.jwks(spec.jwksUri!), {
      issuer: spec.acceptedIssuers,
      audience: cfg.clientId,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 60,
    }));
  } catch {
    throw new SocialAuthError('SOCIAL_ID_TOKEN_INVALID', 401, 'The provider ID token could not be verified.');
  }
  const tokenNonce = claimString(payload, 'nonce');
  if (!tokenNonce || !timingSafeEqual(tokenNonce, nonce)) {
    throw new SocialAuthError('SOCIAL_ID_TOKEN_INVALID', 401, 'The provider ID token was not issued for this sign-in.');
  }
  if (!payload.sub) throw new SocialAuthError('SOCIAL_ID_TOKEN_INVALID', 401, 'The provider ID token has no subject.');
  return payload;
}

// ── Google ────────────────────────────────────────────────────────────────

async function resolveGoogle(cfg: ProviderRuntimeConfig, input: CodeExchangeInput, deps: ProviderDeps): Promise<SocialProfile> {
  if (!cfg.clientSecret) throw notConfigured(cfg.provider);
  const token = await postForm(deps, PROVIDER_SPECS.google.tokenUrl, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.callbackUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: input.codeVerifier,
  });
  const claims = await verifyIdToken(cfg, token.id_token, input.nonce, deps);
  return {
    provider: 'google',
    issuer: PROVIDER_SPECS.google.issuer,
    subject: String(claims.sub),
    email: claimString(claims, 'email'),
    emailVerified: claimTrue(claims.email_verified),
    firstName: claimString(claims, 'given_name'),
    lastName: claimString(claims, 'family_name'),
    avatar: claimString(claims, 'picture'),
  };
}

// ── Apple ─────────────────────────────────────────────────────────────────

/**
 * Apple's "client secret" is a short-lived ES256 JWT signed with the team's
 * `.p8` key: `iss` = team id, `sub` = Services ID, `aud` = appleid.apple.com,
 * header `kid` = key id. Apple caps its lifetime at 6 months; we mint a
 * 5-minute one per exchange so there is nothing long-lived to leak.
 */
export async function appleClientSecret(
  apple: { teamId: string; keyId: string; privateKeyPem: string },
  clientId: string,
): Promise<string> {
  let key: CryptoKey;
  try {
    key = await importPKCS8(apple.privateKeyPem, 'ES256');
  } catch {
    throw new SocialAuthError('SOCIAL_PROVIDER_MISCONFIGURED', 500, 'The Apple signing key is not a valid PKCS#8 ES256 key.');
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: apple.keyId })
    .setIssuer(apple.teamId)
    .setSubject(clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}

/** Parse Apple's first-authorization `user` form field; anything malformed is ignored. */
export function parseAppleUser(raw: string | null | undefined): { firstName: string | null; lastName: string | null } {
  if (!raw) return { firstName: null, lastName: null };
  try {
    const parsed = JSON.parse(raw) as { name?: { firstName?: unknown; lastName?: unknown } };
    const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : null);
    return { firstName: clean(parsed?.name?.firstName), lastName: clean(parsed?.name?.lastName) };
  } catch {
    return { firstName: null, lastName: null };
  }
}

async function resolveApple(cfg: ProviderRuntimeConfig, input: CodeExchangeInput, deps: ProviderDeps): Promise<SocialProfile> {
  if (!cfg.apple) throw notConfigured(cfg.provider);
  const token = await postForm(deps, PROVIDER_SPECS.apple.tokenUrl, {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.callbackUri,
    client_id: cfg.clientId,
    client_secret: await appleClientSecret(cfg.apple, cfg.clientId),
  });
  const claims = await verifyIdToken(cfg, token.id_token, input.nonce, deps);
  const name = parseAppleUser(input.appleUser);
  return {
    provider: 'apple',
    issuer: PROVIDER_SPECS.apple.issuer,
    subject: String(claims.sub),
    email: claimString(claims, 'email'),
    emailVerified: claimTrue(claims.email_verified),
    // Only present on the first authorization; null afterwards.
    firstName: name.firstName,
    lastName: name.lastName,
    avatar: null,
  };
}

// ── GitHub ────────────────────────────────────────────────────────────────

async function githubGet(deps: ProviderDeps, path: string, accessToken: string): Promise<unknown> {
  let res: Response;
  try {
    res = await deps.fetch(`${GITHUB_API}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'LumiBase-CMS',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw upstreamError('GitHub could not be reached.');
  }
  if (!res.ok) throw upstreamError(`GitHub ${path} answered ${res.status}.`);
  return res.json().catch(() => null);
}

interface GithubEmail {
  email?: unknown;
  primary?: unknown;
  verified?: unknown;
}

/** The primary address, and whether GitHub verified it. Never a secondary address. */
export function pickGithubEmail(emails: unknown): { email: string | null; verified: boolean } {
  if (!Array.isArray(emails)) return { email: null, verified: false };
  const primary = (emails as GithubEmail[]).find((e) => e && e.primary === true && typeof e.email === 'string');
  if (!primary) return { email: null, verified: false };
  return { email: String(primary.email), verified: primary.verified === true };
}

function splitName(full: unknown): { firstName: string | null; lastName: string | null } {
  if (typeof full !== 'string' || !full.trim()) return { firstName: null, lastName: null };
  const parts = full.trim().split(/\s+/);
  const first = parts.shift() ?? null;
  return { firstName: first, lastName: parts.length ? parts.join(' ') : null };
}

async function resolveGithub(cfg: ProviderRuntimeConfig, input: CodeExchangeInput, deps: ProviderDeps): Promise<SocialProfile> {
  if (!cfg.clientSecret) throw notConfigured(cfg.provider);
  const token = await postForm(deps, PROVIDER_SPECS.github.tokenUrl, {
    code: input.code,
    redirect_uri: input.callbackUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: input.codeVerifier,
  });
  const accessToken = typeof token.access_token === 'string' ? token.access_token : '';
  if (!accessToken) throw upstreamError('GitHub returned no access token.');
  const user = (await githubGet(deps, '/user', accessToken)) as { id?: unknown; name?: unknown; avatar_url?: unknown } | null;
  if (!user || (typeof user.id !== 'number' && typeof user.id !== 'string')) {
    throw upstreamError('GitHub returned no user id.');
  }
  const { email, verified } = pickGithubEmail(await githubGet(deps, '/user/emails', accessToken));
  const name = splitName(user.name);
  return {
    provider: 'github',
    issuer: PROVIDER_SPECS.github.issuer,
    subject: String(user.id),
    email,
    emailVerified: verified,
    firstName: name.firstName,
    lastName: name.lastName,
    avatar: typeof user.avatar_url === 'string' ? user.avatar_url : null,
  };
}

function notConfigured(provider: SocialProvider): SocialAuthError {
  return new SocialAuthError('SOCIAL_PROVIDER_NOT_CONFIGURED', 503, `Sign in with ${provider} is not configured for this site.`);
}

/** Provider for a stored identity issuer, or null (e.g. the legacy external-id issuer). */
export function providerForIssuer(issuer: string): SocialProvider | null {
  for (const p of SOCIAL_PROVIDERS) if (PROVIDER_SPECS[p].issuer === issuer) return p;
  return null;
}
