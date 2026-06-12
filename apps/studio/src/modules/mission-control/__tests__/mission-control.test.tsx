// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

/**
 * Component tests for the Mission Control module (content-os tasks 17-18).
 *
 * The whole module talks to the backend through one `missionControlApi`
 * object, so mocking that module gives deterministic data + spies on every
 * mutation without a network or React-Router. Each test asserts the panel
 * renders its data AND that the primary human action calls the right API
 * with the right arguments — the behaviours that matter for an operator
 * console (approve, veto, two-step freeze, NL compile).
 *
 * **Validates: Requirements 16.1, 16.2, 16.3, 16.5, 16.6**
 */

// ── API mock: per-test overridable spies. ──────────────────────────────────
// Declared via vi.hoisted so the spies exist before vi.mock (which is hoisted
// to the top of the module) references them.
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
  killSwitch: vi.fn(),
  activateKillSwitch: vi.fn().mockResolvedValue(undefined),
  liftKillSwitch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../api', () => ({ missionControlApi: api }));

import { ExceptionInbox } from '../inbox';
import { TrustLedger } from '../trust-ledger';
import { SloHealth } from '../slo-health';
import { KillSwitchPanel } from '../kill-switch';
import { IntentComposer } from '../intent-composer';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  // Sensible empty defaults; individual tests override what they need.
  api.approvals.mockResolvedValue([]);
  api.staged.mockResolvedValue([]);
  api.autonomy.mockResolvedValue({ grants: [], openIncidents: [] });
  api.intents.mockResolvedValue([]);
  api.killSwitch.mockResolvedValue({ active: [], history: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExceptionInbox', () => {
  it('shows inbox-zero when there is nothing to act on', async () => {
    renderWithClient(<ExceptionInbox />);
    expect(await screen.findByText(/inbox zero/i)).toBeInTheDocument();
  });

  it('renders a pending approval and approves it via the API', async () => {
    api.approvals.mockResolvedValue([
      {
        id: 'apr_1',
        runId: 'run_1',
        subjectType: 'tool_call',
        subjectId: 'tc_1',
        status: 'pending',
        kind: 'approval',
        autoCommitAt: null,
        requestedByAgent: 'writer',
        approverType: 'human',
        createdAt: new Date().toISOString(),
      },
    ]);
    renderWithClient(<ExceptionInbox />);

    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    fireEvent.click(approveBtn);
    await waitFor(() => expect(api.decideApproval).toHaveBeenCalledWith('apr_1', 'approved'));
  });

  it('sorts a veto countdown above a pending approval and vetoes on click', async () => {
    api.approvals.mockResolvedValue([
      {
        id: 'apr_1',
        runId: 'run_1',
        subjectType: 'tool_call',
        subjectId: 'tc_1',
        status: 'pending',
        kind: 'approval',
        autoCommitAt: null,
        requestedByAgent: 'writer',
        approverType: 'human',
        createdAt: new Date().toISOString(),
      },
    ]);
    api.staged.mockResolvedValue([
      {
        approvalId: 'veto_1',
        revisionId: 'rev_1',
        autoCommitAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        collection: 'articles',
        itemId: 'item_1',
        agentRole: 'writer',
        patch: { title: 'Agent title' },
      },
    ]);
    renderWithClient(<ExceptionInbox />);

    // The veto entry (hard deadline) sorts first.
    const items = await screen.findAllByRole('listitem');
    expect(items[0]!).toHaveTextContent(/staged change/i);
    expect(items[0]!).toHaveTextContent(/left/i); // countdown

    fireEvent.click(screen.getByRole('button', { name: /^veto$/i }));
    await waitFor(() => expect(api.veto).toHaveBeenCalledWith('veto_1', expect.any(String)));
  });
});

describe('TrustLedger', () => {
  it('renders the grant matrix and decides a promotion proposal', async () => {
    api.autonomy.mockResolvedValue({
      grants: [
        {
          id: 'g1',
          agentRole: 'writer',
          capability: 'items:write',
          level: 3,
          evidence: {},
          grantedAt: new Date().toISOString(),
        },
      ],
      openIncidents: [],
    });
    api.promotions.mockResolvedValue([
      { id: 'prop_1', status: 'pending', createdAt: new Date().toISOString() },
    ]);
    renderWithClient(<TrustLedger />);

    expect(await screen.findByText('writer')).toBeInTheDocument();
    expect(screen.getByText(/L3 veto-window/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /approve raise/i }));
    await waitFor(() => expect(api.decidePromotion).toHaveBeenCalledWith('prop_1', 'approved'));
  });
});

describe('SloHealth', () => {
  it('shows 100% health for an intent with no open drifts', async () => {
    api.intents.mockResolvedValue([
      {
        id: 'i1',
        name: 'articles-fresh',
        collection: 'articles',
        rules: [],
        schedule: '0 * * * *',
        autonomyCap: 2,
        status: 'active',
        statusReason: null,
      },
    ]);
    api.drifts.mockResolvedValue([]);
    renderWithClient(<SloHealth />);

    expect(await screen.findByText('articles-fresh')).toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });
});

describe('KillSwitchPanel — two-step freeze confirm (Req 16.6)', () => {
  it('keeps the freeze button disabled until the scope name is typed', async () => {
    renderWithClient(<KillSwitchPanel />);

    // Select the "Freeze site" scope (needs confirm, no target).
    fireEvent.click(await screen.findByRole('button', { name: /freeze site/i }));

    // The action button (distinct from the scope selector) is disabled until armed.
    const actionButtons = screen.getAllByRole('button', { name: /freeze site/i });
    const action = actionButtons[actionButtons.length - 1]!;
    expect(action).toBeDisabled();
    expect(api.activateKillSwitch).not.toHaveBeenCalled();

    // Type the confirmation token → armed.
    const confirmInput = screen.getByRole('textbox', { name: /type site to confirm/i });
    fireEvent.change(confirmInput, { target: { value: 'site' } });
    expect(action).not.toBeDisabled();

    fireEvent.click(action);
    await waitFor(() => expect(api.activateKillSwitch).toHaveBeenCalledWith('site', undefined, undefined));
  });
});

describe('IntentComposer — primary CTA (Req 16.5)', () => {
  it('compiles NL to rules, then confirms to create the intent', async () => {
    api.compileIntent.mockResolvedValue({ name: 'fresh', collection: 'articles', rules: [] });
    renderWithClient(<IntentComposer onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/describe the desired state/i), {
      target: { value: 'articles must be fresh' },
    });
    fireEvent.click(screen.getByRole('button', { name: /compile to rules/i }));
    await waitFor(() => expect(api.compileIntent).toHaveBeenCalledWith('articles must be fresh'));

    // The compiled JSON lands in the review box; confirming creates the intent.
    fireEvent.click(screen.getByRole('button', { name: /confirm & create intent/i }));
    await waitFor(() => expect(api.createIntent).toHaveBeenCalled());
  });
});
