// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * Agents page tests (content-os-ui task 16.2).
 *
 * **Validates: Requirements 16.2, 16.4, 16.5**
 */

const api = vi.hoisted(() => ({
  roles: vi.fn(),
  createRole: vi.fn(),
  updateRole: vi.fn(),
  deleteRole: vi.fn(),
}));

vi.mock('../api', () => ({ missionControlApi: api }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/mission-control/agents', search: {} } }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

import { AgentsPage } from '../agents-page';

const WRITER = {
  id: 'role_1',
  name: 'writer',
  description: 'Writes content',
  systemPromptRef: null,
  model: 'demo-llm',
  capabilities: ['items:update'],
  enabled: true,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AgentsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.roles.mockResolvedValue([WRITER]);
  api.createRole.mockResolvedValue(WRITER);
  api.updateRole.mockResolvedValue(WRITER);
  api.deleteRole.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AgentsPage', () => {
  it('renders the role library with capabilities and enabled state', async () => {
    renderPage();
    expect(await screen.findByText('writer')).toBeInTheDocument();
    expect(screen.getByText('items:update')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'writer enabled' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('creates a role with the parsed capability list (Req 16.2)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /new role/i }));

    fireEvent.change(screen.getByPlaceholderText('fact_checker'), {
      target: { value: 'librarian' },
    });
    fireEvent.change(screen.getByPlaceholderText('items:update, review:content'), {
      target: { value: 'items:read, items:archive' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));

    await waitFor(() =>
      expect(api.createRole).toHaveBeenCalledWith({
        name: 'librarian',
        capabilities: ['items:read', 'items:archive'],
      }),
    );
  });

  it('requires a second click to delete (Req 16.4)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete writer' }));
    expect(api.deleteRole).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(api.deleteRole).toHaveBeenCalledWith('writer'));
  });

  it('surfaces the backend error when the list fails (Req 16.5)', async () => {
    api.roles.mockRejectedValue(new Error('Managing agent roles requires an admin.'));
    renderPage();
    expect(
      await screen.findByText('Managing agent roles requires an admin.'),
    ).toBeInTheDocument();
  });
});
