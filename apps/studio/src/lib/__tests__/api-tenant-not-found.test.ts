// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1044: a site id left from an earlier session or database made every tenant
 * request answer `404 TENANT_NOT_FOUND`, silently, on every page load.
 */
describe('handleTenantNotFound', () => {
  let assign: ReturnType<typeof vi.fn>;
  const access = (siteId: string) => `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ siteId, aud: 'studio' }))}.signature`;
  const notFound = () => Response.json({ errors: [{ code: 'TENANT_NOT_FOUND', message: 'Unknown site.' }] }, { status: 404 });

  async function load(pathname: string) {
    vi.resetModules();
    window.history.replaceState(null, '', pathname);
    assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, pathname, search: '', assign },
    });
    return import('@/lib/api');
  }

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('recognises the TENANT_NOT_FOUND body only', async () => {
    const api = await load('/');
    expect(api.isTenantNotFound({ errors: [{ code: 'TENANT_NOT_FOUND' }] })).toBe(true);
    expect(api.isTenantNotFound({ errors: [{ code: 'NOT_FOUND' }] })).toBe(false);
    expect(api.isTenantNotFound(null)).toBe(false);
    expect(api.isTenantNotFound('Not Found')).toBe(false);
  });

  it('clears a stale stored site and reloads the page once, keeping a valid session', async () => {
    const api = await load('/admin-a7f3c1/content/posts');
    api.setActiveSite('site_gone');
    api.setActiveToken(access('site_live'));

    api.handleTenantNotFound('site_gone');
    api.handleTenantNotFound('site_gone');

    expect(localStorage.getItem('lumibase.dev.site')).toBeNull();
    expect(api.getActiveSite()).toBe('__default__');
    expect(api.hasActiveToken()).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith('/admin-a7f3c1/content/posts');
  });

  it('signs out a token bound to the unknown site and sends it to the login', async () => {
    const api = await load('/admin-a7f3c1/content/posts');
    api.setActiveSite('site_gone');
    api.setActiveToken(access('site_gone'));
    api.setActiveRefreshToken('refresh_gone');

    api.handleTenantNotFound('site_gone');

    expect(localStorage.getItem('lumibase.dev.site')).toBeNull();
    expect(api.hasActiveToken()).toBe(false);
    expect(api.getActiveRefreshToken()).toBe('');
    expect(assign).toHaveBeenCalledWith('/admin-a7f3c1/login');
  });

  it('cleans up on the setup wizard without navigating away from it', async () => {
    const api = await load('/setup/account');
    api.setActiveSite('site_gone');
    api.setActiveToken(access('site_gone'));

    api.handleTenantNotFound('site_gone');

    expect(localStorage.getItem('lumibase.dev.site')).toBeNull();
    expect(api.hasActiveToken()).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it('does nothing when no stale id is stored, so the reloaded page cannot loop', async () => {
    const api = await load('/content/posts');
    api.setActiveToken(access('site_live'));

    api.handleTenantNotFound('__default__');

    expect(api.hasActiveToken()).toBe(true);
    expect(assign).not.toHaveBeenCalled();
  });

  it('runs from the API client when a request answers TENANT_NOT_FOUND', async () => {
    const api = await load('/content/posts');
    api.setActiveSite('site_gone');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => notFound());

    await expect(api.getApiClient().rawRequest('/api/v1/site')).rejects.toMatchObject({ status: 404 });

    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).get('X-Lumi-Site')).toBe('site_gone');
    expect(localStorage.getItem('lumibase.dev.site')).toBeNull();
    expect(assign).toHaveBeenCalledTimes(1);

    // The next request names the default site.
    fetchMock.mockImplementation(async () => Response.json({ data: {} }));
    await api.getApiClient().rawRequest('/api/v1/site');
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get('X-Lumi-Site')).toBe('__default__');
  });

  it('leaves an ordinary route 404 alone', async () => {
    const api = await load('/content/posts');
    api.setActiveSite('site_live');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ errors: [{ code: 'NOT_FOUND', message: 'Item not found.' }] }, { status: 404 }),
    );

    await expect(api.getApiClient().rawRequest('/api/v1/items/posts/x')).rejects.toMatchObject({ status: 404 });

    expect(api.getActiveSite()).toBe('site_live');
    expect(assign).not.toHaveBeenCalled();
  });
});
