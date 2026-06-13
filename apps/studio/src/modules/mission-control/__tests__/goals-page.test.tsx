// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * Goal tree tests (content-os-ui task 13.1).
 *
 * **Validates: Requirements 12.1, 12.2, 12.3, 12.4**
 */

const api = vi.hoisted(() => ({
  goals: vi.fn(),
  runs: vi.fn(),
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

import { buildGoalTree, GoalsPage } from '../goals-page';
import type { AgentGoalRow } from '../api';

function goal(over: Partial<AgentGoalRow>): AgentGoalRow {
  return {
    id: 'g1',
    title: 'goal',
    status: 'open',
    origin: 'user',
    parentGoalId: null,
    intentId: null,
    agentRole: null,
    assigneeAgent: 'lumibase-copilot',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GoalsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.goals.mockResolvedValue([]);
  api.runs.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('buildGoalTree', () => {
  it('nests children under their parent and keeps orphans as roots (Req 12.4)', () => {
    const roots = buildGoalTree([
      goal({ id: 'parent', title: 'plan launch', origin: 'planner' }),
      goal({ id: 'child', parentGoalId: 'parent', title: 'write copy' }),
      goal({ id: 'orphan', parentGoalId: 'gone_from_page', title: 'orphan goal' }),
    ]);
    expect(roots.map((r) => r.goal.id).sort()).toEqual(['orphan', 'parent']);
    expect(roots.find((r) => r.goal.id === 'parent')!.children.map((c) => c.goal.id)).toEqual([
      'child',
    ]);
  });
});

describe('GoalsPage', () => {
  it('renders the tree with role badges, latest run and intent link (Req 12.1-12.3)', async () => {
    api.goals.mockResolvedValue([
      goal({ id: 'parent', title: 'plan launch', origin: 'planner', agentRole: 'planner' }),
      goal({
        id: 'child',
        parentGoalId: 'parent',
        title: 'write copy',
        agentRole: 'writer',
        status: 'in_progress',
        intentId: 'int_1',
      }),
    ]);
    api.runs.mockResolvedValue([
      {
        id: 'run_1',
        goalId: 'child',
        agentName: 'writer',
        model: 'demo-llm',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    renderPage();

    expect(await screen.findByText('plan launch')).toBeInTheDocument();
    expect(screen.getByText('write copy')).toBeInTheDocument();
    expect(screen.getByText('writer')).toBeInTheDocument();
    expect(screen.getByText('in_progress')).toBeInTheDocument();
    expect(screen.getByText(/last run: running/)).toBeInTheDocument();
    expect(screen.getByText('Intent →')).toHaveAttribute(
      'href',
      '/mission-control/intents/int_1',
    );
  });

  it('shows an empty state without goals', async () => {
    renderPage();
    expect(await screen.findByText(/no goals yet/i)).toBeInTheDocument();
  });
});
