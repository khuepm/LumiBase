// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setActiveToken, clearActiveToken } from '@/lib/api';
import { probeSiteAccess } from '../site-access';
import { shellUrlToIntentPath } from '../shell-deep-link';

afterEach(() => clearActiveToken());

function response(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('probeSiteAccess (cross-site refusal)', () => {
  it('allows only when the CMS returns the user on that site', async () => {
    setActiveToken('tok');
    const fetcher = vi.fn(async () => response(200, { data: { userId: 'u1', siteId: 'site_b' } }));
    expect(await probeSiteAccess('site_b', fetcher)).toBe('allowed');
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Lumi-Site']).toBe('site_b');
  });

  it.each([401, 403, 404])('denies on %s', async (status) => {
    setActiveToken('tok');
    expect(await probeSiteAccess('site_b', async () => response(status))).toBe('denied');
  });

  it('denies an anonymous or other-site profile even on 200', async () => {
    setActiveToken('tok');
    expect(await probeSiteAccess('site_b', async () => response(200, { data: { userId: null, siteId: 'site_b' } }))).toBe('denied');
    expect(await probeSiteAccess('site_b', async () => response(200, { data: { userId: 'u', siteId: 'site_a' } }))).toBe('denied');
  });

  it('reports errors and fails closed without a token or with a bad id', async () => {
    setActiveToken('tok');
    expect(await probeSiteAccess('site_b', async () => response(500))).toBe('error');
    expect(await probeSiteAccess('site_b', async () => { throw new TypeError('offline'); })).toBe('error');
    expect(await probeSiteAccess('bad id', vi.fn())).toBe('denied');
    clearActiveToken();
    const fetcher = vi.fn();
    expect(await probeSiteAccess('site_b', fetcher)).toBe('denied');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('shell deep links → intent route', () => {
  it.each([
    ['lumibase://intent/edit?collection=posts&id=p1&field=title', '/intent/edit?collection=posts&id=p1&field=title'],
    ['lumibase:///intent/open?collection=posts', '/intent/open?collection=posts'],
    ['https://studio.lumibase.dev/intent/create?collection=posts', '/intent/create?collection=posts'],
  ])('%s → %s', (url, path) => {
    expect(shellUrlToIntentPath(url)).toBe(path);
  });

  it.each([
    'lumibase://auth/callback?code=x',
    'lumibase://intent/delete?collection=posts',
    'https://evil.example/intent/edit?collection=posts',
    'https://studio.lumibase.dev:444/intent/edit?collection=posts',
    'lumibase://intent/edit/extra?collection=posts',
    'not a url',
    42,
  ])('ignores %j', (url) => {
    expect(shellUrlToIntentPath(url)).toBeNull();
  });
});
