// @vitest-environment jsdom
/**
 * #757 progressive dashboard: each Mission Control card/widget renders as
 * soon as its own source answers. A slow source shows a placeholder on its
 * own card only — never a fake value — and never holds back the rest.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';

/** Sources that never answer during the test (the "slowest widget"). */
const PENDING = new Set(['autonomy', 'staged', 'runs', 'goals']);
const RESOLVED: Record<string, unknown> = {
  approvals: [],
  questions: [],
  intents: [],
  killSwitch: { active: [{ id: 'f1' }, { id: 'f2' }] },
};

vi.mock('@/modules/mission-control/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const missionControlApi = new Proxy(
    {},
    {
      get: (_t, prop) => () => {
        const name = String(prop);
        if (PENDING.has(name)) return new Promise(() => {});
        if (name in RESOLVED) return Promise.resolve(RESOLVED[name]);
        return Promise.resolve([]);
      },
    },
  );
  return { ...actual, missionControlApi };
});

import { MissionControlPage } from '@/modules/mission-control/index-page';

afterEach(cleanup);

function renderDashboard() {
  const rootRoute = createRootRoute();
  const page = createRoute({ getParentRoute: () => rootRoute, path: '/mission-control', component: MissionControlPage });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/mission-control'] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('Mission Control dashboard is progressive (#757)', () => {
  it('paints answered cards while slow sources keep their own placeholders', async () => {
    const queryClient = renderDashboard();

    // Kill switch answered: its card shows the real value…
    expect(await screen.findByText('active freezes')).toBeInTheDocument();
    expect(await screen.findByText('2')).toBeInTheDocument();
    // …approvals/questions/intents answered: "awaiting decision" is real (0).
    expect(await screen.findByText('awaiting decision')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading awaiting decision')).toBeNull();

    // Autonomy (incidents) and staged never answered: placeholders, not "0".
    expect(screen.getByLabelText('Loading open incidents')).toBeInTheDocument();
    expect(screen.getByLabelText('Loading nothing staged')).toBeInTheDocument();

    // Widgets render independently: the slow activity feed does not block SLO health.
    expect(screen.getByRole('region', { name: 'SLO health' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Agent activity' })).toBeInTheDocument();
    queryClient.clear();
  });
});
