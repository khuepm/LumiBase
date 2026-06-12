// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * Activity feed tests (content-os-ui task 11.2).
 *
 * **Validates: Requirements 10.1, 10.3**
 */

const api = vi.hoisted(() => ({
  runs: vi.fn(),
  goals: vi.fn(),
}));

vi.mock('../api', () => ({ missionControlApi: api }));

import { ActivityFeed } from '../activity-feed';

function renderWithClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ActivityFeed />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.runs.mockResolvedValue([]);
  api.goals.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ActivityFeed', () => {
  it('renders runs with agent, model, status and the joined goal title (Req 10.1)', async () => {
    api.runs.mockResolvedValue([
      {
        id: 'run_1',
        goalId: 'goal_1',
        agentName: 'writer',
        model: 'demo-llm',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      },
    ]);
    api.goals.mockResolvedValue([
      { id: 'goal_1', title: 'rewrite stale article', status: 'done' },
    ]);
    renderWithClient();

    expect(await screen.findByText('writer')).toBeInTheDocument();
    expect(screen.getByText(/demo-llm/)).toBeInTheDocument();
    expect(screen.getByText('succeeded')).toBeInTheDocument();
    expect(screen.getByText('rewrite stale article')).toBeInTheDocument();
  });

  it('falls back to a shortened goal id when the goal is unknown (Req 10.3)', async () => {
    api.runs.mockResolvedValue([
      {
        id: 'run_2',
        goalId: 'goal_unknown_123',
        agentName: 'translator',
        model: 'demo-llm',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    renderWithClient();

    expect(await screen.findByText('translator')).toBeInTheDocument();
    expect(screen.getByText(/goal goal_unk/)).toBeInTheDocument();
  });

  it('shows an empty state when there are no runs', async () => {
    renderWithClient();
    expect(await screen.findByText(/no agent runs yet/i)).toBeInTheDocument();
  });
});
