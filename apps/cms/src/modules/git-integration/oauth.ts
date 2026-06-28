/**
 * OAuth helpers for the PAT/OAuth connect flow (GitHub + GitLab).
 *
 * The authorize URL is generated for an *authenticated* admin and opened by the
 * browser; the callback is public but bound to a single-use `state` stored in
 * the cache (so it carries the site + integration context without a session).
 */
import type { GitOAuthConfig } from './config';

export type OAuthProvider = 'github' | 'gitlab';

const DEFAULT_SCOPES: Record<OAuthProvider, string> = {
  // Least-privilege: read repo + statuses; PRs/CI are covered by repo scope.
  github: 'repo',
  gitlab: 'api read_api',
};

export function buildAuthorizeUrl(
  provider: OAuthProvider,
  config: GitOAuthConfig,
  redirectUri: string,
  state: string,
): string {
  if (provider === 'github') {
    const p = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: DEFAULT_SCOPES.github,
      state,
    });
    return `https://github.com/login/oauth/authorize?${p.toString()}`;
  }
  const p = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DEFAULT_SCOPES.gitlab,
    state,
  });
  return `https://gitlab.com/oauth/authorize?${p.toString()}`;
}

export interface ExchangeResult {
  accessToken: string;
  scopes: string[];
}

/** Exchange an authorization code for an access token. */
export async function exchangeCodeForToken(
  provider: OAuthProvider,
  config: GitOAuthConfig,
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<ExchangeResult> {
  if (provider === 'github') {
    const res = await fetchFn('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) throw new Error(`GitHub token exchange -> ${res.status}`);
    const data = (await res.json()) as {
      access_token?: string;
      scope?: string;
      error?: string;
    };
    if (!data.access_token) {
      throw new Error(`GitHub token exchange failed: ${data.error ?? 'no token'}`);
    }
    return {
      accessToken: data.access_token,
      scopes: data.scope ? data.scope.split(',').filter(Boolean) : [],
    };
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const res = await fetchFn('https://gitlab.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`GitLab token exchange -> ${res.status}`);
  const data = (await res.json()) as { access_token?: string; scope?: string };
  if (!data.access_token) throw new Error('GitLab token exchange: no token');
  return {
    accessToken: data.access_token,
    scopes: data.scope ? data.scope.split(' ').filter(Boolean) : [],
  };
}
