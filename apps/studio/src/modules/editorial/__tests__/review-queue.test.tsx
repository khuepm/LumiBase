// @vitest-environment jsdom
/**
 * Review queue with Jev automation suggestions (J11, #518): routed items and
 * shadow suggestions are listed next to pending reviews; accept / override /
 * reject post feedback on the decision; nothing applies a suggestion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LumiError } from '@lumibase/sdk';
import type { AutomationActionView } from '../automation-suggestions';

const rawRequest = vi.fn();
vi.mock('@/lib/api', () => ({ getApiClient: () => ({ rawRequest }) }));
vi.mock('@/lib/use-permissions', () => ({ usePermissions: () => ({ can: () => true, isAdmin: true }) }));

import { ReviewQueue } from '../review-queue';

function suggestion(overrides: Partial<AutomationActionView> = {}): AutomationActionView {
  return {
    id: 'act_1',
    action: 'route',
    mode: 'shadow',
    status: 'recorded',
    reason: 'mode_shadow',
    itemId: 'itm_1',
    questionKey: 'category',
    confidence: 0.91,
    inZone: true,
    proposed: { field: 'review_queue', value: 'newsdesk', target: 'newsdesk', transition: 'submit_review' },
    approvalId: null,
    chain: { reviewRunId: 'rr_1', revisionId: 'rev_1', feedback: [] },
    ...overrides,
  };
}

let actions: AutomationActionView[];
let feedbackError: unknown;

function renderQueue() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReviewQueue collection="posts" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  actions = [
    suggestion(),
    suggestion({
      id: 'act_2',
      action: 'tag',
      itemId: 'itm_2',
      mode: 'live',
      status: 'pending_approval',
      reason: null,
      proposed: { field: 'tags', value: ['news'], target: 'news' },
      approvalId: 'apr_1',
    }),
  ];
  feedbackError = null;
  rawRequest.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.startsWith('/api/v1/editorial/reviews')) {
      return { data: [{ id: 'cr_1', itemId: 'itm_9', revisionId: null, requestedBy: 'usr_a', assignedTo: null, status: 'pending', reason: null, createdAt: '' }] };
    }
    if (path.startsWith('/api/v1/ai/automation/actions?')) return { data: actions };
    if (path.endsWith('/feedback') && init?.method === 'POST') {
      if (feedbackError) throw feedbackError;
      return { data: [] };
    }
    throw new Error(`unexpected ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const posts = () => rawRequest.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

describe('automation suggestions in the review queue', () => {
  it('shows pending reviews, routed items and shadow suggestions with their state', async () => {
    renderQueue();
    expect(await screen.findByText(/itm_9/)).toBeInTheDocument();
    const routed = await screen.findByTestId('automation-act_1');
    expect(routed).toHaveTextContent('Queue: newsdesk');
    expect(routed).toHaveTextContent('then submit_review');
    expect(routed).toHaveTextContent('Shadow suggestion');
    expect(routed).toHaveTextContent('in auto-action zone');
    expect(screen.getByTestId('automation-act_2')).toHaveTextContent('Live · awaiting approval');
    expect(rawRequest).toHaveBeenCalledWith('/api/v1/ai/automation/actions?collection=posts&limit=50');
  });

  it('accept posts feedback and applies nothing', async () => {
    renderQueue();
    const row = await screen.findByTestId('automation-act_1');
    fireEvent.click(within(row).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [path, init] = posts()[0]!;
    expect(path).toBe('/api/v1/ai/automation/actions/act_1/feedback');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ verdict: 'accept' });
    // No item, flow or editorial endpoint was called to apply the suggestion.
    expect(rawRequest.mock.calls.some(([p]) => /\/items\/|\/editorial\/posts\//.test(String(p)))).toBe(false);
  });

  it('override sends the corrected value as an edit', async () => {
    renderQueue();
    const row = await screen.findByTestId('automation-act_1');
    const override = within(row).getByRole('button', { name: 'Override' });
    expect(override).toBeDisabled();
    fireEvent.change(within(row).getByLabelText('Override value for itm_1'), { target: { value: 'ads-review' } });
    fireEvent.click(override);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toEqual({ verdict: 'edit', editedValue: 'ads-review' });
  });

  it('a stale decision asks before recording the verdict', async () => {
    feedbackError = new LumiError(409, { errors: [{ code: 'REVIEW_STALE', message: 'changed' }] });
    renderQueue();
    const row = await screen.findByTestId('automation-act_1');
    fireEvent.click(within(row).getByRole('button', { name: 'Reject' }));
    expect(await within(row).findByRole('alert')).toHaveTextContent('The item changed since this decision');
    feedbackError = null;
    fireEvent.click(within(row).getByRole('button', { name: 'Record anyway' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(JSON.parse(String((posts()[1]![1] as RequestInit).body))).toEqual({ verdict: 'reject', acknowledgeStale: true });
  });

  it('a recorded verdict replaces the buttons', async () => {
    actions = [suggestion({ chain: { reviewRunId: 'rr_1', revisionId: 'rev_1', feedback: [{ verdict: 'accept', editedValue: null, principalId: 'usr_a' }] } })];
    renderQueue();
    const row = await screen.findByTestId('automation-act_1');
    expect(row).toHaveTextContent('Verdict recorded: accept');
    expect(within(row).queryByRole('button', { name: 'Accept' })).toBeNull();
  });

  it('a non-admin sees a note instead of the list', async () => {
    rawRequest.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/v1/editorial/reviews')) return { data: [] };
      throw new LumiError(403, { errors: [{ code: 'CONTROL_PLANE_FORBIDDEN', message: 'admin' }] });
    });
    renderQueue();
    expect(await screen.findByText('Automation suggestions are visible to site admins only.')).toBeInTheDocument();
  });
});
