// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { adminBaseRewrite, getAdminBase, withAdminPrefix } from '../admin-base';

describe('getAdminBase', () => {
  it('detects a private admin prefix', () => {
    expect(getAdminBase('/admin-a7f3c1/content/posts')).toBe('/admin-a7f3c1');
  });

  it.each([
    '/content/posts',
    '/insights/overview',
    '/teams',
    '/setup/path',
    '/login',
    '/',
  ])('returns no prefix for %s', (pathname) => {
    expect(getAdminBase(pathname)).toBe('');
  });
});

describe('withAdminPrefix', () => {
  it('prefixes module paths and the root', () => {
    expect(withAdminPrefix('/content/posts/1', '/admin-a7f3c1')).toBe('/admin-a7f3c1/content/posts/1');
    expect(withAdminPrefix('/', '/admin-a7f3c1')).toBe('/admin-a7f3c1');
  });

  it('leaves already-prefixed, root-only and setup paths alone', () => {
    expect(withAdminPrefix('/admin-a7f3c1/files', '/admin-a7f3c1')).toBe('/admin-a7f3c1/files');
    expect(withAdminPrefix('/teams', '/admin-a7f3c1')).toBe('/teams');
    expect(withAdminPrefix('/setup/done', '/admin-a7f3c1')).toBe('/setup/done');
  });

  it('is a no-op without a prefix', () => {
    expect(withAdminPrefix('/content/posts', '')).toBe('/content/posts');
  });
});

describe('adminBaseRewrite in the router', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  function buildRouter() {
    const rootRoute = createRootRoute();
    const itemRoute = createRoute({ getParentRoute: () => rootRoute, path: '/content/$collection/$id' });
    const prefixedItemRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/$adminPath/content/$collection/$id',
    });
    return createRouter({
      routeTree: rootRoute.addChildren([itemRoute, prefixedItemRoute]),
      rewrite: adminBaseRewrite,
    });
  }

  it('keeps the private prefix on unprefixed links', () => {
    window.history.replaceState(null, '', '/admin-a7f3c1/content/posts');
    const location = buildRouter().buildLocation({
      to: '/content/$collection/$id',
      params: { collection: 'posts', id: 'abc' },
    });
    expect(location.publicHref).toBe('/admin-a7f3c1/content/posts/abc');
  });

  it('does not invent a prefix on an unprefixed instance', () => {
    window.history.replaceState(null, '', '/content/posts');
    const location = buildRouter().buildLocation({
      to: '/content/$collection/$id',
      params: { collection: 'posts', id: 'abc' },
    });
    expect(location.publicHref).toBe('/content/posts/abc');
  });
});
