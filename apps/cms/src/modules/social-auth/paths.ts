/**
 * Paths of the social login surface (#736), shared by the routers and the
 * middleware that must let them through without a session.
 */

/** Public prefix: providers list, start, provider callback, code exchange. */
export const SOCIAL_AUTH_PUBLIC_PREFIX = '/api/v1/auth/social/';

/**
 * Provider callback: `/api/v1/auth/social/callback/:siteId/:provider`.
 *
 * The browser arrives here from Google / Apple / GitHub with no `X-Lumi-Site`
 * header, so the site travels in the path (it is also inside the server-side
 * state, and the two must agree).
 */
const CALLBACK_RE = /^\/api\/v1\/auth\/social\/callback\/([^/]+)\/[^/]+\/?$/;

export function isSocialAuthPublicPath(path: string): boolean {
  return path.startsWith(SOCIAL_AUTH_PUBLIC_PREFIX);
}

/** Site id carried by a provider-callback path, or null for any other path. */
export function socialCallbackSiteId(path: string): string | null {
  const m = CALLBACK_RE.exec(path);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return '';
  }
}

export function callbackPath(siteId: string, provider: string): string {
  return `/api/v1/auth/social/callback/${encodeURIComponent(siteId)}/${provider}`;
}
