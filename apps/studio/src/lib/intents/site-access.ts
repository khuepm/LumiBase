/**
 * Does the signed-in user have access to another site? (issue #759)
 *
 * The CMS is the authority: the bearer-token middleware accepts a Studio
 * session on a site only when the user is a member of that site or inherits
 * access through its organization. We ask it directly with `GET
 * /api/v1/auth/me` and the target `X-Lumi-Site`, using a bare `fetch` so a
 * refusal (401/403) is NOT routed through the global 401 handler — which would
 * clear the session for a site the user never switched to.
 *
 * Fails closed: anything but a 2xx is `denied` or `error`.
 */
import { getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';

export type SiteAccess = 'allowed' | 'denied' | 'error';

const SITE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function probeSiteAccess(
  siteId: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<SiteAccess> {
  if (!SITE_ID.test(siteId)) return 'denied';
  const token = getActiveToken();
  if (!token) return 'denied';
  try {
    const res = await fetcher(`${getApiBaseUrl()}/api/v1/auth/me`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'X-Lumi-Site': siteId,
        'X-Lumi-Client': 'studio',
      },
    });
    if (res.ok) {
      // A 2xx must also prove an authenticated user on THAT site; an
      // anonymous profile (no userId) or another site id is a refusal.
      const body = (await res.json().catch(() => null)) as {
        data?: { userId?: unknown; siteId?: unknown };
      } | null;
      const ok = typeof body?.data?.userId === 'string' && body.data.userId.length > 0 && body.data.siteId === siteId;
      return ok ? 'allowed' : 'denied';
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) return 'denied';
    return 'error';
  } catch {
    return 'error';
  }
}
