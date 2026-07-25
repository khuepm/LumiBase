// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Change Feed panel tests (cdc-extension-integration task 14.2).
 * Renders with sample data, checks the status/lag presentation, and pins the
 * confirm dialog on destructive actions (delete/replay never fire without
 * confirmation — Req 8.3).
 *
 * **Validates: Requirements 8.1, 8.3**
 */

const rawRequest = vi.fn();

vi.mock('@/lib/api', () => ({
  getActiveToken: () => 'token',
  getActiveSite: () => 'site_1',
  getApiClient: () => ({ rawRequest }),
}));

import {
  ChangeFeedPage,
  formatLag,
  type ChangeFeedSubscription,
} from '../change-feed-page';

const SUB: ChangeFeedSubscription = {
  id: 'sub_1',
  name: 'algolia-sync',
  kind: 'webhook',
  status: 'active',
  collections: ['posts'],
  operations: [],
  payloadMode: 'reference',
  cursor: null,
  lastDeliveredAt: '2026-07-10T00:00:00.000Z',
  consecutiveFailures: 0,
  lag: { events: 12, behindMs: 90_000 },
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ChangeFeedPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockResolvedValue({ data: [SUB] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ChangeFeedPage', () => {
  it('renders subscriptions with kind, status badge, and lag (Req 8.1)', async () => {
    renderPage();
    expect(await screen.findByText('algolia-sync')).toBeTruthy();
    expect(screen.getByTestId('status-sub_1').textContent).toBe('active');
    expect(screen.getByText(/12 events/)).toBeTruthy();
    expect(screen.getAllByText('webhook').length).toBeGreaterThan(0);
  });

  it('delete requires confirmation and is skipped when declined (Req 8.3)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByText('algolia-sync');
    fireEvent.click(screen.getByLabelText('Delete algolia-sync'));
    expect(confirmSpy).toHaveBeenCalledOnce();
    // rawRequest chỉ được gọi cho list — không có DELETE nào bắn ra.
    expect(
      rawRequest.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
  });

  it('delete fires after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('algolia-sync');
    fireEvent.click(screen.getByLabelText('Delete algolia-sync'));
    await waitFor(() =>
      expect(
        rawRequest.mock.calls.some(
          ([path, init]) =>
            String(path).includes('/subscriptions/sub_1') &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true),
    );
  });

  it('replay prompts for a timestamp and confirms before rewinding (Req 8.3)', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('2026-07-10T00:00:00.000Z');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByText('algolia-sync');
    fireEvent.click(screen.getByLabelText('Replay algolia-sync'));
    expect(confirmSpy).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(
        rawRequest.mock.calls.some(([path]) => String(path).includes('/replay')),
      ).toBe(true),
    );
  });

  it('shows the empty state when there are no subscriptions', async () => {
    rawRequest.mockResolvedValue({ data: [] });
    renderPage();
    expect(await screen.findByText(/No change-feed subscriptions yet/)).toBeTruthy();
  });
});

describe('formatLag', () => {
  it('renders caught-up, seconds, and minutes forms', () => {
    expect(formatLag({ events: 0, behindMs: null })).toBe('caught up');
    expect(formatLag({ events: 3, behindMs: 5_000 })).toBe('3 events (~5s behind)');
    expect(formatLag({ events: 12, behindMs: 90_000 })).toBe('12 events (~2m behind)');
    expect(formatLag({ events: 4, behindMs: null })).toBe('4 events');
  });
});
