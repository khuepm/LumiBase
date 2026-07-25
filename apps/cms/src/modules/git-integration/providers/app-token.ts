/**
 * GitHub App installation-token minting.
 *
 * Builds a short-lived App JWT (RS256), exchanges it for an installation
 * access token, and caches the result until shortly before expiry. The App's
 * private key must be PKCS#8 PEM (`BEGIN PRIVATE KEY`); convert a classic
 * `BEGIN RSA PRIVATE KEY` with
 * `openssl pkcs8 -topk8 -nocrypt -in key.pem`.
 *
 * GitLab has no equivalent App-token model — OAuth/group tokens are stored and
 * used like PATs — so this helper is GitHub-only.
 */
import type { CacheProvider } from '@lumibase/runtime';
import { ProviderApiError } from './types';

export interface GitHubAppConfig {
  appId: string;
  /** PKCS#8 PEM private key. */
  privateKeyPem: string;
}

export interface MintInstallationTokenDeps {
  fetchFn?: typeof fetch;
  cache?: CacheProvider;
  baseUrl?: string;
  /** Injectable clock (epoch seconds) for deterministic tests. */
  nowSeconds?: () => number;
}

const API_BASE = 'https://api.github.com';

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(obj: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

/** Strip PEM armour and decode the base64 body to DER bytes. */
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function signAppJwt(
  config: GitHubAppConfig,
  nowSeconds: number,
): Promise<string> {
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'pkcs8',
      pemToDer(config.privateKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new ProviderApiError(
      'GitHub App private key must be PKCS#8 PEM (BEGIN PRIVATE KEY)',
    );
  }
  const header = base64UrlEncodeJson({ alg: 'RS256', typ: 'JWT' });
  // Backdate iat 60s to tolerate clock skew; exp max 10 min per GitHub.
  const payload = base64UrlEncodeJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: config.appId,
  });
  const signingInput = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/**
 * Mint (or return a cached) installation access token for the given
 * installation. Tokens last ~1h; we cache for 50 min keyed by installation id.
 */
export async function mintGitHubInstallationToken(
  config: GitHubAppConfig,
  installationId: string,
  deps: MintInstallationTokenDeps = {},
): Promise<string> {
  const fetchFn = deps.fetchFn ?? fetch;
  const baseUrl = deps.baseUrl ?? API_BASE;
  const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const cacheKey = `git:gh-inst-token:${config.appId}:${installationId}`;

  if (deps.cache) {
    const cached = await deps.cache.get<string>(cacheKey);
    if (cached) return cached;
  }

  const jwt = await signAppJwt(config, nowSeconds());
  const res = await fetchFn(
    `${baseUrl}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LumiBase',
      },
    },
  );
  if (!res.ok) {
    throw new ProviderApiError(
      `GitHub installation token mint -> ${res.status}`,
      res.status,
    );
  }
  const data = (await res.json()) as { token: string };
  if (deps.cache) {
    await deps.cache.set(cacheKey, data.token, { ttl: 3000 });
  }
  return data.token;
}
