// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * Exception notifications in the bell panel (content-os-ui task 14.1).
 * Two poll cycles are simulated through the React Query cache: the first
 * load initializes the seen-set silently (Req 14.3); a refetch that brings
 * a new staged entry produces a notification deep-linking to the inbox
 * (Req 14.1, 14.2).
 *
 * **Validates: Requirements 14.1, 14.2, 14.3**
 */

const api = vi.hoisted(() => ({
  approvals: vi.fn(),
  staged: vi.fn(),
  autonomy: vi.fn(),
  intents: vi.fn(),
}));

vi.mock('@/modules/mission-control/api', () => ({ missionControlApi: api }));

const linkProps = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children, onClick }: {
    to: string;
    search?: Record<string, string>;
    children: ReactNode;
    onClick?: () => void;
  }) => {
    linkProps.last = { to, search };
    const qs = search ? `?${new URLSearchParams(search).toString()}` : '';
    return (
      <a href={`${String(to)}${qs}`} onClick={onClick}>
        {children}
      </a>
    );
  },
  useRouterState: () => ({ location: { pathname: '/files', search: {} } }),
}));

import { NotificationsPanel } from '../notifications-panel';

const STAGED = {
  approvalId: 'veto_9',
  autoCommitAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  collection: 'articles',
  itemId: 'item_9',
  agentRole: 'writer',
  patch: { title: 'x' },
};

let queryClient: QueryClient;

function renderPanel() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no ws in tests')));
  api.approvals.mockResolvedValue([]);
  api.staged.mockResolvedValue([]);
  api.autonomy.mockResolvedValue({ grants: [], openIncidents: [] });
  api.intents.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('NotificationsPanel — exception notifications', () => {
  it('stays silent on first load, then notifies and deep-links a fresh staged entry', async () => {
    renderPanel();

    // First load completes: everything current counts as seen (Req 14.3).
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(
      screen.getByRole('button', { name: /^notifications$/i }),
    ).toBeInTheDocument(); // no "(n unread)" suffix

    // Next poll brings a brand-new staged change.
    api.staged.mockResolvedValue([STAGED]);
    await act(async () => {
      await queryClient.refetchQueries();
    });

    const bell = await screen.findByRole('button', { name: /1 unread/i });
    fireEvent.click(bell);

    expect(
      await screen.findByText(/staged change on articles\/item_9/i),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /open/i });
    expect(link).toHaveAttribute('href', '/mission-control/inbox?entry=veto%3Aveto_9');
    expect(linkProps.last).toEqual({
      to: '/mission-control/inbox',
      search: { entry: 'veto:veto_9' },
    });
  });
});
