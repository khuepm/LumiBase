// @vitest-environment jsdom
/**
 * #757 acceptance: a Studio boot makes at most two permission/identity
 * requests — one `GET /permissions/me` and one `GET /me/preferences` — even
 * though the shell, the language sync, `usePermissions` and the save-action
 * hook all ask for that data on the same render.
 *
 * The real `AppShell` is mounted (with its sidebar, palettes, notification
 * panel, footer…) inside a real router, with a page that also calls the
 * per-page hooks. Every outgoing request — SDK client calls and bare
 * `fetch` — is recorded by path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const requests: string[] = [];

/**
 * Deep stub of the SDK client: any `client.a.b.c(...)` resolves `{ data: [] }`
 * and records a synthetic path; `rawRequest(path)` records the real path; the
 * two boot reads record the endpoint paths they hit in production.
 */
function stubClient(): unknown {
  const make = (trail: string[]): unknown =>
    new Proxy(() => undefined, {
      get(_t, prop) {
        if (prop === 'then') return undefined; // not a thenable
        return make([...trail, String(prop)]);
      },
      apply(_t, _this, args: unknown[]) {
        const name = trail.join('.');
        if (name === 'rawRequest') {
          requests.push(String(args[0]).split('?')[0] ?? '');
          return Promise.resolve({ data: {} });
        }
        if (name === 'permissions.me') {
          requests.push('/api/v1/permissions/me');
          return Promise.resolve({ data: { admin: true, byKey: {} } });
        }
        if (name === 'me.getPreferences') {
          requests.push('/api/v1/me/preferences');
          return Promise.resolve({ data: {} });
        }
        requests.push(`sdk:${name}`);
        // `orgs.*` resolves bare arrays (not `{ data }`) in the real SDK.
        if (name.startsWith('orgs.')) return Promise.resolve([]);
        return Promise.resolve({ data: [] });
      },
    });
  return make([]);
}

vi.mock('@/lib/api', () => {
  const client = stubClient();
  return {
    getApiClient: () => client,
    hasActiveToken: () => true,
    getActiveToken: () => 'token',
    getActiveSite: () => 'site_boot',
    getSessionSite: () => 'site_boot',
    getSessionGeneration: () => 0,
    setActiveSite: vi.fn(),
    clearActiveToken: vi.fn(),
    logout: vi.fn(async () => undefined),
  };
});

import { AppShell } from '@/components/app-shell';
import { usePermissions } from '@/lib/use-permissions';
import { useSaveAction } from '@/modules/content/use-save-action';

const PERMISSION_ENDPOINTS = ['/api/v1/permissions/me', '/api/v1/me/preferences'];
const isPermissionCall = (path: string) =>
  PERMISSION_ENDPOINTS.includes(path) || /\/permissions\b|\/auth\/me\b|\/users\/me\b/.test(path);

function ContentPage() {
  const perms = usePermissions();
  const save = useSaveAction();
  return (
    <div>
      <h1>Content</h1>
      <p data-testid="perms">{perms.isLoading ? 'loading' : perms.isAdmin ? 'admin' : 'user'}</p>
      <p data-testid="save">{String(save.effective)}</p>
    </div>
  );
}

function renderBoot() {
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell>
        <Outlet />
      </AppShell>
    ),
  });
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: ContentPage });
  const router = createRouter({
    routeTree: rootRoute.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return queryClient;
}

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(new URL(url, 'http://localhost').pathname);
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Studio boot permission requests (#757)', () => {
  it('fetches the permission bundle and the preferences exactly once each — ≤ 2 permission calls', async () => {
    const queryClient = renderBoot();
    await waitFor(() => expect(screen.getByTestId('perms')).toHaveTextContent('admin'));
    // Let every other boot query settle so a late duplicate would be counted.
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));

    const permissionCalls = requests.filter(isPermissionCall);
    expect(permissionCalls.length).toBeLessThanOrEqual(2);
    expect(permissionCalls.filter((p) => p === '/api/v1/permissions/me')).toHaveLength(1);
    expect(permissionCalls.filter((p) => p === '/api/v1/me/preferences')).toHaveLength(1);
    queryClient.clear();
  });

  it('keeps the drag-and-drop and command-palette chunks off the boot render', async () => {
    const queryClient = renderBoot();
    await screen.findByRole('heading', { name: 'Content' });
    // Read-only sidebar: plain links, no drag handles.
    const sidebar = screen.getByRole('navigation', { name: 'Module navigation' });
    expect(within(sidebar).getByRole('link', { name: 'Content' })).toHaveAttribute('aria-current', 'page');
    expect(within(sidebar).queryByRole('button', { name: /^Move / })).toBeNull();
    // Command palette is not mounted until opened.
    expect(screen.queryByPlaceholderText(/command/i)).toBeNull();
    queryClient.clear();
  });

  it('loads the sortable sidebar on demand when an admin starts reordering', async () => {
    const queryClient = renderBoot();
    const sidebar = await screen.findByRole('navigation', { name: 'Module navigation' });
    fireEvent.click(await within(sidebar).findByRole('button', { name: 'Reorder modules' }));
    // The read-only links stay up as the Suspense fallback, then the drag handles arrive.
    expect(await within(sidebar).findByRole('button', { name: 'Move Content' })).toBeInTheDocument();
    expect(within(sidebar).queryByRole('link', { name: 'Content' })).toBeNull();
    queryClient.clear();
  });
});
