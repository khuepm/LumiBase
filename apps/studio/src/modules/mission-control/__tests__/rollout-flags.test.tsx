// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Rollout flags switchboard tests (content-os-ui task 15.2).
 *
 * **Validates: Requirements 15.2, 15.3**
 */

const api = vi.hoisted(() => ({
  contentOsFlags: vi.fn(),
  saveContentOsFlags: vi.fn(),
}));

vi.mock('../api', () => ({ missionControlApi: api }));

import { RolloutFlagsPanel } from '../rollout-flags';

const ALL_OFF = { reconciler: false, vetoWindow: false, agentReview: false, mcp: false };

function renderWithClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RolloutFlagsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.contentOsFlags.mockResolvedValue({ flags: { ...ALL_OFF }, raw: {} });
  api.saveContentOsFlags.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RolloutFlagsPanel', () => {
  it('renders the four flags off with the baseline note', async () => {
    renderWithClient();

    expect(await screen.findByRole('switch', { name: 'Reconciler' })).toBeInTheDocument();
    for (const label of ['Reconciler', 'Veto window', 'Agent review', 'MCP endpoint']) {
      expect(screen.getByRole('switch', { name: label })).toHaveAttribute(
        'aria-checked',
        'false',
      );
    }
    expect(screen.getByText(/behaves exactly like the pre-Content-OS baseline/i)).toBeInTheDocument();
  });

  it('enabling takes a two-step confirm and merges over the raw row value (Req 15.2, 15.3)', async () => {
    api.contentOsFlags.mockResolvedValue({
      flags: { ...ALL_OFF },
      // Non-flag key on the same settings row — must survive the toggle.
      raw: { agentReviewMinConfidence: 0.9 },
    });
    renderWithClient();

    fireEvent.click(await screen.findByRole('switch', { name: 'Reconciler' }));
    // First click arms only — nothing saved yet.
    expect(api.saveContentOsFlags).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm enable' }));
    await waitFor(() =>
      expect(api.saveContentOsFlags).toHaveBeenCalledWith({
        agentReviewMinConfidence: 0.9,
        reconciler: true,
        vetoWindow: false,
        agentReview: false,
        mcp: false,
      }),
    );
  });

  it('cancel disarms without saving', async () => {
    renderWithClient();

    fireEvent.click(await screen.findByRole('switch', { name: 'Veto window' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(api.saveContentOsFlags).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Confirm enable' })).not.toBeInTheDocument();
  });

  it('disabling applies on the first click (Req 15.2)', async () => {
    api.contentOsFlags.mockResolvedValue({
      flags: { ...ALL_OFF, mcp: true },
      raw: { mcp: true },
    });
    renderWithClient();

    const mcpSwitch = await screen.findByRole('switch', { name: 'MCP endpoint' });
    expect(mcpSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(mcpSwitch);
    await waitFor(() =>
      expect(api.saveContentOsFlags).toHaveBeenCalledWith({
        reconciler: false,
        vetoWindow: false,
        agentReview: false,
        mcp: false,
      }),
    );
  });
});
