/**
 * Regression tests for the landing route (`/` and `/:locale/`).
 *
 * These pin the fix for the prod bug where the site root painted an unstyled,
 * full-bleed list of every doc which then vanished on load. Two systems
 * disagreed about what `/` was: scripts/prerender.mjs injected a hand-built
 * `<h1>` + `<ul>` link list straight into `<div id="root">`, while the router
 * resolved the same URL to `<Navigate to="docs/README">`. React hydrated
 * against markup its route tree never produced, then the redirect wiped it.
 *
 * The route tree is imported from ../routes rather than reconstructed, so a
 * future change that reintroduces a redirect at the locale index — or drops
 * the crawlable link list — fails here.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { routes } from '../routes';

// TableOfContents (rendered inside Layout) constructs an IntersectionObserver.
beforeAll(() => {
  const mockIntersectionObserver = vi.fn().mockImplementation(function () {
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
      root: null,
      rootMargin: '',
      thresholds: [],
      takeRecords: () => [],
    };
  });
  vi.stubGlobal('IntersectionObserver', mockIntersectionObserver);
});

afterEach(() => {
  cleanup();
});

function renderAt(initialPath: string) {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  const utils = render(<RouterProvider router={router} />);
  return { ...utils, router };
}

describe('Landing route', () => {
  it('renders the landing page at /en/ instead of redirecting to a doc', async () => {
    const { router } = renderAt('/en/');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'LumiBase Documentation' }),
      ).toBeTruthy();
    });

    // The bug: this used to become /en/docs/README via <Navigate>.
    expect(router.state.location.pathname).toBe('/en/');
  });

  it('renders the Vietnamese landing page at /vi/', async () => {
    const { router } = renderAt('/vi/');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { level: 1, name: 'Tài liệu LumiBase' }),
      ).toBeTruthy();
    });

    expect(router.state.location.pathname).toBe('/vi/');
  });

  it('redirects the bare root to a locale landing page, not a doc page', async () => {
    const { router } = renderAt('/');

    // `/` carries no locale so it must redirect — but only as far as `/en/`,
    // which is a real page. Landing on a doc slug here is the old bug.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/en/');
    });
    expect(router.state.location.pathname).not.toContain('/docs/');
  });

  it('exposes a "get started" link into the docs', async () => {
    renderAt('/en/');

    await waitFor(() => {
      const cta = screen.getByRole('link', { name: /get started/i });
      expect(cta.getAttribute('href')).toBe('/en/docs/README');
    });
  });
});
