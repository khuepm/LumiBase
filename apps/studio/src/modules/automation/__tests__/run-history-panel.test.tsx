// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Run history panel tests (visual-flow-builder Req 6.2, 6.3).
 * **Validates: Requirements 6.2**
 */

vi.mock('@/lib/api', () => ({ getActiveToken: () => 'tok', getActiveSite: () => 'site_1' }));

import { RunHistoryPanel } from '../run-history-panel';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ data }) } as Response;
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RunHistoryPanel flowId="flow_1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
});

describe('RunHistoryPanel', () => {
  it('lists runs and loads per-node steps when a run is selected', async () => {
    // First call → run list; second call → selected run detail.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse([
          { id: 'run_abcd1234', status: 'success', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z', error: null },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'run_abcd1234',
          status: 'success',
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: '2026-01-01T00:00:01Z',
          error: null,
          input: { a: 1 },
          steps: { node_log: { logged: true }, previous: { logged: true } },
        }),
      );

    renderPanel();

    await waitFor(() => expect(screen.getByText('run_abcd')).toBeTruthy());
    fireEvent.click(screen.getByText('run_abcd'));

    // Detail loads: input + a per-node step (the synthetic `previous` key is hidden).
    await waitFor(() => expect(screen.getByText('Input')).toBeTruthy());
    expect(screen.getByText('node_log')).toBeTruthy();
    expect(screen.queryByText('previous')).toBeNull();
  });
});
