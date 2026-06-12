// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

/**
 * Component tests for Mission Control v2 (content-os-ui tasks 4.3, 5.4, 6.3).
 *
 * The router is mocked wholesale: these components only consume Link /
 * useRouterState / useNavigate / useParams, so a stub keeps the tests on
 * the behaviour that matters — diffs render from real item data, vetoes
 * carry the typed reason, pause/resume hit the right endpoints, provenance
 * renders only what was recorded.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 4.2, 4.3, 5.4, 5.5**
 */

const api = vi.hoisted(() => ({
  approvals: vi.fn(),
  decideApproval: vi.fn().mockResolvedValue(undefined),
  staged: vi.fn(),
  veto: vi.fn().mockResolvedValue(undefined),
  autonomy: vi.fn(),
  promotions: vi.fn().mockResolvedValue([]),
  decidePromotion: vi.fn().mockResolvedValue(undefined),
  intents: vi.fn().mockResolvedValue([]),
  drifts: vi.fn().mockResolvedValue([]),
  compileIntent: vi.fn(),
  createIntent: vi.fn().mockResolvedValue({}),
  resumeIntent: vi.fn().mockResolvedValue(undefined),
  constitution: vi.fn().mockResolvedValue({ versions: [], active: null }),
  compileConstitution: vi.fn(),
  createConstitutionDraft: vi.fn(),
  dryRunConstitution: vi.fn(),
  activateConstitution: vi.fn(),
  killSwitch: vi.fn().mockResolvedValue({ active: [], history: [] }),
  activateKillSwitch: vi.fn().mockResolvedValue(undefined),
  liftKillSwitch: vi.fn().mockResolvedValue(undefined),
}));

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  location: {
    pathname: '/mission-control/inbox',
    search: {} as Record<string, unknown>,
  },
  params: {} as Record<string, string>,
}));

const itemDetail = vi.hoisted(() => vi.fn());

vi.mock('../api', () => ({ missionControlApi: api }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: routerMocks.location }),
  useNavigate: () => routerMocks.navigate,
  useParams: () => routerMocks.params,
}));

vi.mock('@/lib/api', () => ({
  getApiClient: () => ({
    items: () => ({ detail: itemDetail }),
  }),
}));

import { StagedDiff } from '../staged-diff';
import { InboxPage } from '../inbox-page';
import { IntentDetailPage } from '../intent-detail';
import { ProvenanceBadge, ProvenancePanel } from '@/modules/content/provenance-badge';
import type { RevisionRow } from '@lumibase/sdk';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const STAGED = {
  approvalId: 'veto_1',
  autoCommitAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  collection: 'articles',
  itemId: 'item_1',
  agentRole: 'writer',
  patch: { title: 'Agent title' },
};

beforeEach(() => {
  api.approvals.mockResolvedValue([]);
  api.staged.mockResolvedValue([]);
  api.autonomy.mockResolvedValue({ grants: [], openIncidents: [] });
  api.intents.mockResolvedValue([]);
  api.drifts.mockResolvedValue([]);
  itemDetail.mockResolvedValue({ data: { id: 'item_1', data: { title: 'Human title', body: 'same' } } });
  routerMocks.location.pathname = '/mission-control/inbox';
  routerMocks.location.search = {};
  routerMocks.params = {};
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('StagedDiff (Req 3.2, 3.3)', () => {
  it('renders a field-level diff of the patch against the current item', async () => {
    renderWithClient(<StagedDiff veto={STAGED} />);

    // The changed field shows both sides; the untouched field stays hidden.
    expect(await screen.findByText('Human title')).toBeInTheDocument();
    expect(screen.getByText('Agent title')).toBeInTheDocument();
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.queryByText('body')).not.toBeInTheDocument();
  });

  it('falls back to staged values with a notice when the item cannot load', async () => {
    itemDetail.mockRejectedValue(new Error('404'));
    renderWithClient(<StagedDiff veto={STAGED} />);

    expect(await screen.findByText(/could not load the current item/i)).toBeInTheDocument();
    expect(screen.getByText('Agent title')).toBeInTheDocument();
    expect(screen.getByText(/added/i)).toBeInTheDocument();
  });
});

describe('InboxPage (Req 3.1, 3.4, 1.4)', () => {
  it('opens the deep-linked entry and vetoes with the typed reason', async () => {
    api.staged.mockResolvedValue([STAGED]);
    routerMocks.location.search = { entry: 'veto:veto_1' };
    renderWithClient(<InboxPage />);

    // Detail pane shows the diff for the selected staged change.
    expect(await screen.findByText('Human title')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/veto reason/i), {
      target: { value: 'wrong tone' },
    });
    // The detail pane's veto button (the list has its own).
    const vetoButtons = screen.getAllByRole('button', { name: /^veto$/i });
    fireEvent.click(vetoButtons[vetoButtons.length - 1]!);
    await waitFor(() => expect(api.veto).toHaveBeenCalledWith('veto_1', 'wrong tone'));
  });

  it('degrades gracefully when the deep-linked entry no longer exists', async () => {
    routerMocks.location.search = { entry: 'veto:gone' };
    renderWithClient(<InboxPage />);

    expect(await screen.findByText(/this entry is gone/i)).toBeInTheDocument();
  });
});

describe('IntentDetailPage (Req 5.4, 5.5)', () => {
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

  it('pauses an active intent through the kill switch intent scope', async () => {
    api.intents.mockResolvedValue([INTENT]);
    routerMocks.params = { intentId: 'int_1' };
    routerMocks.location.pathname = '/mission-control/intents/int_1';
    renderWithClient(<IntentDetailPage />);

    expect(await screen.findByText('articles-fresh')).toBeInTheDocument();
    expect(screen.getByText('freshness')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    await waitFor(() =>
      expect(api.activateKillSwitch).toHaveBeenCalledWith('intent', 'int_1', expect.any(String)),
    );
  });

  it('resumes a paused intent through the resume endpoint', async () => {
    api.intents.mockResolvedValue([{ ...INTENT, status: 'paused' }]);
    routerMocks.params = { intentId: 'int_1' };
    renderWithClient(<IntentDetailPage />);

    fireEvent.click(await screen.findByRole('button', { name: /resume/i }));
    await waitFor(() => expect(api.resumeIntent).toHaveBeenCalledWith('int_1'));
  });

  it('shows not-found for an unknown intent id', async () => {
    routerMocks.params = { intentId: 'nope' };
    renderWithClient(<IntentDetailPage />);

    expect(await screen.findByText(/intent not found/i)).toBeInTheDocument();
    expect(screen.getByText(/back to intents/i)).toBeInTheDocument();
  });
});

describe('Provenance (Req 4.2, 4.3)', () => {
  const AGENT_REVISION = {
    id: 'rev_1',
    siteId: 's1',
    collectionId: 'c1',
    itemId: 'item_1',
    delta: {},
    userId: null,
    createdAt: new Date().toISOString(),
    authorType: 'agent',
    model: 'claude-x',
    createdByRunId: 'run_9',
    constitutionHash: 'sha256:abcdef1234567890',
    confidence: 0.91,
  } as RevisionRow;

  it('badges agent revisions and lists only recorded provenance fields', () => {
    render(
      <div>
        <ProvenanceBadge revision={AGENT_REVISION} />
        <ProvenancePanel revision={AGENT_REVISION} />
      </div>,
    );

    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('claude-x')).toBeInTheDocument();
    expect(screen.getByText('run_9')).toBeInTheDocument();
    expect(screen.getByText('0.91')).toBeInTheDocument();
  });

  it('badges human revisions and renders no provenance panel', () => {
    const human = { ...AGENT_REVISION, authorType: 'human' } as RevisionRow;
    const { container } = render(
      <div>
        <ProvenanceBadge revision={human} />
        <ProvenancePanel revision={human} />
      </div>,
    );

    expect(screen.getByText('human')).toBeInTheDocument();
    expect(container.querySelector('dl')).toBeNull();
  });
});
