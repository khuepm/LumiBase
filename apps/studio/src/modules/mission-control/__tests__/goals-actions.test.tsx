// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * Goal decompose/settle tests (content-os-ui task 18.2).
 *
 * **Validates: Requirements 18.1, 18.2**
 */

const api = vi.hoisted(() => ({
  goals: vi.fn(),
  runs: vi.fn(),
  roles: vi.fn(),
  decomposeGoal: vi.fn(),
  settleGoal: vi.fn(),
}));

vi.mock('../api', () => ({ missionControlApi: api }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/mission-control/goals', search: {} } }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}));

import { GoalsPage } from '../goals-page';

const PARENT = {
  id: 'parent',
  title: 'plan launch',
  status: 'in_progress',
  origin: 'planner',
  parentGoalId: null,
  intentId: null,
  agentRole: 'planner',
  assigneeAgent: 'planner',
  createdAt: new Date().toISOString(),
};

const CHILD = { ...PARENT, id: 'child', title: 'write copy', parentGoalId: 'parent', agentRole: 'writer' };

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GoalsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.goals.mockResolvedValue([PARENT, CHILD]);
  api.runs.mockResolvedValue([]);
  api.roles.mockResolvedValue([
    { id: 'r1', name: 'writer', description: null, systemPromptRef: null, model: null, capabilities: [], enabled: true },
  ]);
  api.decomposeGoal.mockResolvedValue([]);
  api.settleGoal.mockResolvedValue({ ...PARENT, status: 'done' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Goal planner actions', () => {
  it('decomposes a goal with the entered sub-goals (Req 18.1)', async () => {
    renderPage();
    // Open the decompose form on the child (leaf) node.
    const decomposeButtons = await screen.findAllByRole('button', { name: 'Decompose' });
    fireEvent.click(decomposeButtons[1]!);

    fireEvent.change(screen.getByLabelText('Sub-goal 1 title'), {
      target: { value: 'draft intro' },
    });
    // The role select fills async from roles() — wait for the option.
    await screen.findByRole('option', { name: 'writer' });
    fireEvent.change(screen.getByLabelText('Sub-goal 1 role'), { target: { value: 'writer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create sub-goals' }));

    await waitFor(() =>
      expect(api.decomposeGoal).toHaveBeenCalledWith('child', [
        { title: 'draft intro', agentRole: 'writer' },
      ]),
    );
  });

  it('settles a parent goal from its children (Req 18.2)', async () => {
    renderPage();
    // Only the parent (has children) shows Settle.
    fireEvent.click(await screen.findByRole('button', { name: 'Settle' }));
    await waitFor(() => expect(api.settleGoal).toHaveBeenCalledWith('parent'));
  });
});
