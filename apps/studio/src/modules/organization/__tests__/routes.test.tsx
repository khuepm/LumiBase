// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
vi.mock('@/modules/setup/admin-ready-gate', () => ({
  AdminReadyGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/app-shell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
const organization = {
  id: 'route_org',
  name: 'Route Organization',
  slug: 'route-org',
  role: 'owner',
  settings: {},
};
vi.mock('@/lib/api', () => ({
  getActiveToken: () => 'token',
  hasActiveToken: () => true,
  getActiveSite: () => 'site_route',
  getSessionGeneration: () => 0,
  setActiveSite: vi.fn(),
  clearActiveToken: vi.fn(),
  logout: vi.fn(),
  getApiClient: () => ({
    orgs: {
      list: async () => [organization],
      get: async () => organization,
      sites: { list: async () => [] },
      members: { list: async () => [] },
      keys: { list: async () => [] },
      approvals: { list: async () => [] },
    },
  }),
}));
import { router as appRouter } from '@/router';
afterEach(cleanup);
describe('organization Settings routes', () => {
  it.each(['/settings/organization', '/lumi-private/settings/organization'])(
    'resolves %s through the real route tree',
    async (path) => {
      const router = createRouter({
        routeTree: appRouter.routeTree,
        history: createMemoryHistory({ initialEntries: [path] }),
      });
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(
          screen.getByRole('heading', { name: 'Organization', level: 1 }),
        ).toBeInTheDocument(),
      );
      expect(screen.getByLabelText('Organization name')).toHaveValue(
        'Route Organization',
      );
      expect(
        screen.getByRole('link', { name: 'Organization' }),
      ).toHaveAttribute('aria-current', 'page');
      queryClient.clear();
    },
  );
});
