// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * Route-tree integration test for Settings → Deployments.
 *
 * The companion `deployments-page.test.tsx` renders the page in isolation and
 * source-scans the wiring; this one drives the REAL `routeTree` from
 * `router.tsx` over a memory history, so it proves the URL actually resolves
 * to the page and that the sidebar entry links to that same URL. The page had
 * shipped complete but unreachable — a component-only test would have stayed
 * green the whole time it was dead.
 *
 * The app chrome (`AdminReadyGate`, `AppShell`) is stubbed to pass-through:
 * both call the live API on mount and neither is what this test is about.
 */

vi.mock('@/modules/setup/admin-ready-gate', () => ({
  AdminReadyGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Every namespace the lazily-loaded settings pages touch resolves to an empty
// payload — this test asserts routing, not data.
const emptyResult = { data: [] };
const apiClient = new Proxy(
  {},
  {
    get: (): unknown =>
      new Proxy(vi.fn().mockResolvedValue(emptyResult), {
        get: (target, prop) =>
          prop in target
            ? Reflect.get(target, prop)
            : vi.fn().mockResolvedValue(emptyResult),
      }),
  },
);

vi.mock('@/lib/api', () => ({
  getApiClient: () => apiClient,
  getActiveToken: () => 'token',
  getActiveSite: () => 'site_1',
  hasActiveToken: () => true,
  clearActiveToken: vi.fn(),
  logout: vi.fn(),
  getApiBaseUrl: () => 'http://localhost:1989',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

import { router as appRouter } from '@/router';

function renderAt(path: string) {
  const router = createRouter({
    routeTree: appRouter.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(cleanup);

describe('/settings/deployments route', () => {
  it('resolves the URL to the Deployments page inside the settings shell', async () => {
    renderAt('/settings/deployments');

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: 'Deployments', level: 1 })).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    // Rendered inside SettingsLayout, not as a bare page.
    expect(screen.getByRole('complementary', { name: 'Settings navigation' })).toBeInTheDocument();
  });

  it('exposes a sidebar link pointing at the same URL, marked as the active page', async () => {
    renderAt('/settings/deployments');

    const link = await screen.findByRole('link', { name: 'Deployments' });
    expect(link).toHaveAttribute('href', '/settings/deployments');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('also resolves under the custom admin path', async () => {
    renderAt('/my-admin/settings/deployments');

    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: 'Deployments', level: 1 })).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });
});
