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
