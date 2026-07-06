// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Run history panel (visual-flow-builder task 6.4).
 *
 * **Validates: Requirements 6.2, 6.3**
 */

vi.mock('@/lib/api', () => ({
  getActiveToken: () => 'token',
  getActiveSite: () => 'site_1',
}));

import { RunHistoryPanel, type FlowRunDetail } from '../run-history-panel';

const RUN_SUMMARY = {
  id: 'run_1',
  status: 'success' as const,
  startedAt: '2026-07-06T10:00:00.000Z',
  finishedAt: '2026-07-06T10:00:01.500Z',
  error: null,
};

const RUN_DETAIL: FlowRunDetail = {
  ...RUN_SUMMARY,
  input: { event: { collection: 'posts' } },
  steps: { n1: { logged: true }, n2: { status: 200 } },
  output: {},
};

const fetchMock = vi.fn();

function jsonResponse(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ data }) } as Response;
}

function renderPanel(onRunSelected?: (run: FlowRunDetail | null) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RunHistoryPanel flowId="f1" onRunSelected={onRunSelected} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/runs/run_1')) return Promise.resolve(jsonResponse(RUN_DETAIL));
    if (url.includes('/runs')) return Promise.resolve(jsonResponse([RUN_SUMMARY]));
    return Promise.resolve(jsonResponse(null));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('RunHistoryPanel', () => {
  it('lists runs with status and duration', async () => {
    renderPanel();
    expect(await screen.findByText(/1.5s/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/flows/f1/runs', expect.anything());
  });

  it('loads run detail with per-node steps on selection and reports it up', async () => {
    const onRunSelected = vi.fn();
    renderPanel(onRunSelected);
    fireEvent.click(await screen.findByRole('button', { name: /1.5s/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/v1/flows/f1/runs/run_1', expect.anything()),
    );
    expect(await screen.findByTestId('run-detail')).toBeInTheDocument();
    // Both node ids from steps render in the detail JSON (canvas highlight source).
    expect(screen.getByText(/Steps \(2\)/)).toBeInTheDocument();
    await waitFor(() =>
      expect(onRunSelected).toHaveBeenCalledWith(expect.objectContaining({ id: 'run_1', steps: RUN_DETAIL.steps })),
    );
  });

  it('shows an empty state when there are no runs', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([])));
    renderPanel();
    expect(await screen.findByText(/No runs yet/)).toBeInTheDocument();
  });
});
