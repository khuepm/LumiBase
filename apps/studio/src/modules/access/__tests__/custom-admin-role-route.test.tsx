// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

const mcpKey = vi.hoisted(() => ({
  create: vi.fn(async () => ({ data: { id: 'key_1', token: 'lbk_secret' } })),
  attachRole: vi.fn(async () => ({ data: {} })),
}));

vi.mock('@/modules/setup/admin-ready-gate', () => ({ AdminReadyGate: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/app-shell', () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    roles: {
      detail: async () => ({ data: { id: 'role_1', name: 'Administrator', description: '', adminAccess: true, appAccess: true, policies: [], users: [] } }),
      list: async () => ({ data: [{ id: 'role_1', name: 'Administrator', adminAccess: true }] }),
    },
    policies: { list: async () => ({ data: [] }) },
    permissions: { me: async () => ({ data: { admin: true } }) },
    apiKeys: mcpKey,
    schema: { listCollections: async () => ({ data: [] }) },
  }),
  getActiveToken: () => 'token', getActiveSite: () => 'site_1', hasActiveToken: () => true,
  clearActiveToken: vi.fn(), logout: vi.fn(), getApiBaseUrl: () => 'http://localhost:1989',
}));

import { router as appRouter } from '@/router';

afterEach(cleanup);

function renderAt(path: string) {
  const router = createRouter({
    routeTree: appRouter.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  );
}

it('opens Administrator role detail under a custom admin path', async () => {
  renderAt('/lumi-admin/access/roles/role_1');

  expect(await screen.findByDisplayValue('Administrator')).toBeInTheDocument();
  expect(screen.getByText('Attached policies')).toBeInTheDocument();
});

it('opens MCP setup from Data model under a custom admin path', async () => {
  renderAt('/lumi-admin/data-model');

  const link = await screen.findByRole('link', { name: 'Set up MCP for AI' });
  expect(link).toHaveAttribute('href', '/data-model/mcp-setup');
});

it('resolves the MCP setup page under a custom admin path', async () => {
  renderAt('/lumi-admin/data-model/mcp-setup');

  expect(await screen.findByRole('heading', { name: 'Set up MCP for your IDE' })).toBeInTheDocument();
});

it('creates a dedicated key, attaches the chosen role, and shows IDE config', async () => {
  renderAt('/lumi-admin/data-model/mcp-setup');

  await screen.findByRole('option', { name: 'Administrator (admin access)' });
  fireEvent.change(screen.getByLabelText('Role for the AI assistant'), { target: { value: 'role_1' } });
  const createButton = await screen.findByRole('button', { name: 'Create MCP key' });
  await waitFor(() => expect(createButton).toBeEnabled());
  fireEvent.click(createButton);

  expect(await screen.findByText('2. Add LumiBase to your IDE')).toBeInTheDocument();
  expect(mcpKey.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'IDE MCP' }));
  expect(mcpKey.attachRole).toHaveBeenCalledWith('key_1', { roleId: 'role_1' });
  expect(screen.getByText(/lbk_secret/)).toBeInTheDocument();
});
