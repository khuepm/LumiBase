// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

/**
 * Intent lifecycle action tests (content-os-ui task 17.2).
 *
 * **Validates: Requirements 17.1, 17.2, 17.3**
 */

const api = vi.hoisted(() => ({
  intents: vi.fn(),
  drifts: vi.fn(),
  scanIntent: vi.fn(),
  updateIntent: vi.fn(),
  deleteIntent: vi.fn(),
  activateKillSwitch: vi.fn(),
  resumeIntent: vi.fn(),
}));

const navigate = vi.hoisted(() => vi.fn());

vi.mock('../api', () => ({ missionControlApi: api }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({
    location: { pathname: '/mission-control/intents/int_1', search: {} },
  }),
  useNavigate: () => navigate,
  useParams: () => ({ intentId: 'int_1' }),
}));

import { IntentDetailPage } from '../intent-detail';

const INTENT = {
  id: 'int_1',
  name: 'articles-fresh',
  collection: 'articles',
  rules: [{ type: 'freshness', maxAgeDays: 90 }],
  schedule: '0 * * * *',
  autonomyCap: 2,
  status: 'active',
  statusReason: null,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <IntentDetailPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.intents.mockResolvedValue([INTENT]);
  api.drifts.mockResolvedValue([]);
  api.scanIntent.mockResolvedValue({
    scan: { driftsFound: 3 },
    reconcile: { goalsCreated: 2 },
  });
  api.updateIntent.mockResolvedValue(INTENT);
  api.deleteIntent.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('IntentDetail actions', () => {
  it('runs a manual scan and renders the cycle result (Req 17.1)', async () => {
    renderPage();
    // The page gates on the async `intents` query (renders "Loading intent…"
    // first), so wait past the 1000ms default for the initial render on a
    // slow/loaded CI runner before the Scan button exists.
    fireEvent.click(await screen.findByRole('button', { name: /scan now/i }, { timeout: 5000 }));

    await waitFor(() => expect(api.scanIntent).toHaveBeenCalledWith('int_1'));
    expect(await screen.findByText(/reconciliation cycle complete/i)).toBeInTheDocument();
    expect(screen.getByText(/"driftsFound":3/)).toBeInTheDocument();
  });

  it('saves edits through PATCH with parsed JSON (Req 17.2)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /edit/i }, { timeout: 5000 }));

    const nameInput = screen.getByLabelText(/name/i);
    fireEvent.change(nameInput, { target: { value: 'articles-fresher' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(api.updateIntent).toHaveBeenCalledWith('int_1', {
        name: 'articles-fresher',
        schedule: '0 * * * *',
        autonomyCap: 2,
        rules: [{ type: 'freshness', maxAgeDays: 90 }],
        budget: {},
      }),
    );
  });

  it('deletes only after the confirm step, then navigates back (Req 17.3)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete intent' }, { timeout: 5000 }));
    expect(api.deleteIntent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(api.deleteIntent).toHaveBeenCalledWith('int_1'));
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });
});
