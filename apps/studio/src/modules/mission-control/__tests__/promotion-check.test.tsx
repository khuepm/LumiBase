// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Promotion eligibility check tests (content-os-ui task 20.2).
 *
 * **Validates: Requirements 20.1, 20.2**
 */

const api = vi.hoisted(() => ({
  autonomy: vi.fn(),
  promotions: vi.fn(),
  decidePromotion: vi.fn(),
  checkPromotion: vi.fn(),
}));

vi.mock('../api', () => ({ missionControlApi: api }));

import { TrustLedger } from '../trust-ledger';

function renderLedger() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TrustLedger />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  api.autonomy.mockResolvedValue({
    grants: [
      {
        id: 'g1',
        agentRole: 'writer',
        capability: 'items:update',
        level: 2,
        evidence: {},
        grantedAt: new Date().toISOString(),
      },
    ],
    openIncidents: [],
  });
  api.promotions.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PromotionCheck', () => {
  it('sends the entered role and capability (Req 20.1)', async () => {
    api.checkPromotion.mockResolvedValue({ proposed: true });
    renderLedger();

    fireEvent.change(await screen.findByPlaceholderText('writer'), {
      target: { value: 'writer' },
    });
    fireEvent.change(screen.getByPlaceholderText('items:update'), {
      target: { value: 'items:update' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check eligibility' }));

    await waitFor(() =>
      expect(api.checkPromotion).toHaveBeenCalledWith('writer', 'items:update'),
    );
    expect(await screen.findByText(/eligible — a promotion proposal was created/i)).toBeInTheDocument();
  });

  it('renders the verdict when not eligible (Req 20.2)', async () => {
    api.checkPromotion.mockResolvedValue({ proposed: false, reason: 'approval streak too short' });
    renderLedger();

    fireEvent.change(await screen.findByPlaceholderText('writer'), {
      target: { value: 'writer' },
    });
    fireEvent.change(screen.getByPlaceholderText('items:update'), {
      target: { value: 'items:update' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check eligibility' }));

    expect(await screen.findByText('Not eligible yet.')).toBeInTheDocument();
    expect(screen.getByText(/approval streak too short/)).toBeInTheDocument();
  });
});
