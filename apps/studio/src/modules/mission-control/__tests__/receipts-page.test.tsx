// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AgentReceipts } from '../api';

/**
 * Agent receipts page (#713): KPI tiles, threshold alerts, breakdowns, window
 * presets, CSV export and the threshold editor. The API is mocked; the page
 * must render only what the server computed and surface its errors verbatim.
 */

const api = vi.hoisted(() => ({
  receipts: vi.fn(),
  receiptAlerts: vi.fn(),
  setReceiptAlerts: vi.fn(),
  exportReceipts: vi.fn(),
}));

vi.mock('../api', () => ({ missionControlApi: api }));
vi.mock('../intent-composer', () => ({ IntentComposer: () => null }));
vi.mock('../kill-switch', () => ({ KillSwitchPanel: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: { pathname: '/mission-control/receipts', search: {} } }),
}));

import { ReceiptsPage } from '../receipts-page';

function receipts(overrides: Partial<AgentReceipts> = {}): AgentReceipts {
  return {
    window: { since: '2026-10-11T00:00:00.000Z', until: '2026-11-10T00:00:00.000Z' },
    runs: { total: 12, byStatus: { succeeded: 9, failed: 3 }, byAgent: [{ agent: 'translator', total: 12, succeeded: 9, failed: 3 }], failureRate: 0.25 },
    toolCalls: { total: 20, byTool: [{ tool: 'translateItem', total: 20, byStatus: { executed: 18, denied: 2 }, p50LatencyMs: 140 }] },
    approvals: { total: 5, byStatus: { approved: 4, rejected: 1 }, byApprover: { human: 5 }, latency: { count: 5, p50Minutes: 42, p90Minutes: 300, avgMinutes: 80 } },
    vetoes: { total: 2, vetoed: 1, committed: 1, pending: 0, vetoRate: 0.5 },
    questions: { asked: 1, answered: 1, expired: 0, cancelled: 0, pending: 0 },
    overrides: { rejectedApprovals: 1, vetoed: 1, total: 2, overrideRate: 2 / 7 },
    cost: { tokens: 12345, usd: 0.4321, byTool: [{ tool: 'translateItem', tokens: 12345, usd: 0.4321 }] },
    drift: { opened: 3, resolved: 1, openNow: 4, byRule: [{ ruleType: 'freshness', count: 3 }] },
    incidents: { total: 1, bySource: { veto: 1 }, bySeverity: { medium: 1 } },
    autonomy: {
      grants: [],
      levelDistribution: { L0: 0, L1: 0, L2: 1, L3: 1, L4: 0 },
      promotions: [{ at: '2026-11-01T00:00:00.000Z', agentRole: 'translator', capability: 'items:write', toLevel: 3 }],
      demotions: 1,
    },
    daily: [{ date: '2026-11-09', runs: 12, succeeded: 9, failed: 3, approvals: 5, incidents: 1, tokens: 12345, usd: 0.4321 }],
    alerts: [{ metric: 'maxRunFailureRate', value: 0.25, threshold: 0.2, message: 'Run failure rate 0.25 exceeds 0.2' }],
    thresholds: { maxRunFailureRate: 0.2 },
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReceiptsPage />
    </QueryClientProvider>,
  );
}

describe('ReceiptsPage', () => {
  beforeEach(() => {
    api.receipts.mockResolvedValue(receipts());
    api.receiptAlerts.mockResolvedValue({ maxRunFailureRate: 0.2 });
    api.setReceiptAlerts.mockImplementation(async (value: unknown) => value);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders KPI tiles, the crossed threshold and the breakdowns', async () => {
    renderPage();
    expect(await screen.findByText('Run failure rate 0.25 exceeds 0.2')).toBeTruthy();
    expect(screen.getByText('1 threshold crossed')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByText('42 min')).toBeTruthy();
    expect(screen.getByText('$0.4321')).toBeTruthy();
    expect(screen.getAllByText('translateItem').length).toBeGreaterThan(0);
    expect(screen.getByText('executed 18 · denied 2')).toBeTruthy();
    expect(screen.getByText('2026-11-01 translator/items:write')).toBeTruthy();
  });

  it('requests a new window when a preset is chosen', async () => {
    renderPage();
    await screen.findByText('1 threshold crossed');
    const first = api.receipts.mock.calls[0]![0] as { since: string; until: string };
    expect(new Date(first.until).getTime() - new Date(first.since).getTime()).toBe(30 * 86_400_000);
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(api.receipts).toHaveBeenCalledTimes(2));
    const second = api.receipts.mock.calls[1]![0] as { since: string; until: string };
    expect(new Date(second.until).getTime() - new Date(second.since).getTime()).toBe(7 * 86_400_000);
  });

  it('shows a server error verbatim', async () => {
    api.receipts.mockRejectedValue(new Error('The window may span at most 180 days'));
    renderPage();
    expect(await screen.findByText('The window may span at most 180 days')).toBeTruthy();
  });

  it('exports a CSV and reports a failed export', async () => {
    const created = vi.fn(() => 'blob:x');
    const revoked = vi.fn();
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    api.exportReceipts.mockResolvedValueOnce({ blob: new Blob(['a']), truncated: true });
    renderPage();
    await screen.findByText('1 threshold crossed');
    fireEvent.click(screen.getByRole('button', { name: /Tool calls/ }));
    await waitFor(() => expect(api.exportReceipts).toHaveBeenCalledWith('tool_calls', expect.objectContaining({ since: expect.any(String) })));
    expect(await screen.findByText(/truncated at 10,000 rows/)).toBeTruthy();
    expect(revoked).toHaveBeenCalledWith('blob:x');

    api.exportReceipts.mockRejectedValueOnce(new Error('kind must be one of runs, tool_calls, approvals'));
    fireEvent.click(screen.getByRole('button', { name: /Runs$/ }));
    expect(await screen.findByText('kind must be one of runs, tool_calls, approvals')).toBeTruthy();
  });

  it('saves thresholds, leaving empty fields unchecked', async () => {
    renderPage();
    const failure = (await screen.findByLabelText('Run failure rate')) as HTMLInputElement;
    expect(failure.value).toBe('0.2');
    fireEvent.change(failure, { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Open drift'), { target: { value: '7.6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save thresholds' }));
    await waitFor(() => expect(api.setReceiptAlerts).toHaveBeenCalledWith({ maxOpenDrift: 8 }));
  });
});
