// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearActiveToken,
  getActiveRefreshToken,
  logout,
  setActiveRefreshToken,
  setActiveToken,
} from '@/lib/api';

describe('Studio api token storage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('persists and clears access + refresh tokens together', () => {
    setActiveToken('access_1');
    setActiveRefreshToken('refresh_1');
    expect(getActiveRefreshToken()).toBe('refresh_1');

    clearActiveToken();
    expect(getActiveRefreshToken()).toBe('');
    expect(localStorage.getItem('lumibase.dev.token')).toBeNull();
  });

  it('logout() posts to /auth/logout with the refresh token then clears locally', async () => {
    setActiveToken('access_1');
    setActiveRefreshToken('refresh_1');

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { status: 'logged_out' } }), { status: 200 }),
    );

    await logout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/v1/auth/logout');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('X-LumiBase-Refresh')).toBe('1');
    expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'refresh_1' });
    // Tokens cleared regardless.
    expect(getActiveRefreshToken()).toBe('');
  });

  it('logout() still clears local tokens when the network call fails', async () => {
    setActiveToken('access_1');
    setActiveRefreshToken('refresh_1');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    await logout();
    expect(getActiveRefreshToken()).toBe('');
    expect(localStorage.getItem('lumibase.dev.token')).toBeNull();
  });
});

describe('organization transport and switched-site sessions', () => {
  const access = (siteId: string, marker: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ siteId, marker, aud: 'studio' }))}.signature`;
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('omits site headers only on the organization plane', async () => {
    const { getApiClient, setActiveSite } = await import('@/lib/api');
    setActiveToken(access('site_a', 'current')); setActiveSite('site_b');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ data: [] }));
    const client = getApiClient();
    await client.orgs.list();
    await client.orgs.keys.list('org_a');
    await client.rawRequest('/api/v1/items/posts');
    expect(fetchMock.mock.calls.slice(0, 2).every(([, init]) => !new Headers(init?.headers).has('X-Lumi-Site'))).toBe(true);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/api/v1/orgs/org_a/keys');
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get('X-Lumi-Site')).toBe('site_b');
  });

  it('refreshes the original session after switching sites, then retries the organization request', async () => {
    const { getApiClient, getActiveToken, setActiveSite } = await import('@/lib/api');
    setActiveToken(access('site_a', 'expired')); setActiveRefreshToken('refresh_a'); setActiveSite('site_b');
    let orgCalls = 0;
    const fresh = access('site_a', 'fresh');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/auth/refresh')) return Response.json({ data: { token: fresh, refreshToken: 'refresh_a2' } });
      orgCalls++;
      return orgCalls === 1 ? Response.json({ errors: [{ code: 'UNAUTHENTICATED' }] }, { status: 401 })
        : Response.json({ data: [{ id: 'org_a' }] });
    });
    expect(await getApiClient().orgs.list()).toEqual([{ id: 'org_a' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refresh = fetchMock.mock.calls[1]!;
    expect(String(refresh[0])).toContain('/auth/refresh');
    expect(new Headers(refresh[1]?.headers).get('X-Lumi-Site')).toBe('site_a');
    expect(JSON.parse(String(refresh[1]?.body))).toEqual({ refreshToken: 'refresh_a' });
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).has('X-Lumi-Site')).toBe(false);
    expect(getActiveToken()).toBe(fresh);
    expect(getActiveRefreshToken()).toBe('refresh_a2');
    await logout();
    expect(new Headers(fetchMock.mock.calls[3]![1]?.headers).get('X-Lumi-Site')).toBe('site_a');
  });
});
