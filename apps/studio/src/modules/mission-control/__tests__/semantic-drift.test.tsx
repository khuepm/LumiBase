// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

/**
 * Mission Control rendering of semantic drift (Jev J12, #519): the drift list
 * shows the rule key and version, the profile version, the model, the
 * revision and the uncertainty state from what the scan recorded, and
 * nothing else. The SLO table leaves `unevaluated` rows out of the health
 * ratio so an outage never reads as a clean intent.
 */

const api = vi.hoisted(() => ({
  intents: vi.fn(),
  drifts: vi.fn(),
  activateKillSwitch: vi.fn(),
  resumeIntent: vi.fn(),
  scanIntent: vi.fn(),
  deleteIntent: vi.fn(),
  updateIntent: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  params: {} as Record<string, string>,
  location: { pathname: '/mission-control/intents/int_1', search: {} as Record<string, unknown> },
}));

vi.mock('../api', () => ({ missionControlApi: api }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => (
    <a href={String(to)} {...rest}>
      {children}
    </a>
  ),
  useRouterState: () => ({ location: routerMocks.location }),
  useNavigate: () => vi.fn(),
  useParams: () => routerMocks.params,
}));

import { IntentDetailPage } from '../intent-detail';
import { SloTable, sloSummary, useSloRows, type SloRow } from '../slo-table';

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const INTENT = {
  id: 'int_1',
  name: 'brief-alignment',
  collection: 'articles',
  rules: [
    {
      type: 'semantic',
      key: 'off-brief',
      version: 2,
      profileKey: 'brief',
      profileVersion: 3,
      questionKey: 'off_brief',
      threshold: 0.8,
      contextSource: 'field:brief',
    },
  ],
  schedule: '0 6 * * *',
  autonomyCap: 1,
  status: 'active',
  statusReason: null,
};

const HASH = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const OPEN = {
  id: 'd_open',
  intentId: 'int_1',
  itemId: 'item_open',
  ruleType: 'semantic',
  ruleKey: `off-brief@v2:3:${HASH}`,
  status: 'open',
  detail: {
    rule: 'off-brief',
    ruleVersion: 2,
    profileKey: 'brief',
    profileVersion: 3,
    questionKey: 'off_brief',
    threshold: 0.8,
    contextSource: 'field:brief',
    contentHash: HASH,
    revisionId: 'rev_000000000001',
    runId: '0192f0aa-0000-7000-8000-000000000001',
    provider: 'typesafe',
    model: 'jev-1',
    calibrated: true,
    noul: 0.91,
  },
};

const UNEVALUATED = {
  id: 'd_unev',
  intentId: 'int_1',
  itemId: 'item_unev',
  ruleType: 'semantic',
  ruleKey: `off-brief@v2:3:${HASH}`,
  status: 'unevaluated',
  detail: {
    rule: 'off-brief',
    ruleVersion: 2,
    profileKey: 'brief',
    profileVersion: 3,
    questionKey: 'off_brief',
    threshold: 0.8,
    contextSource: 'field:brief',
    contentHash: HASH,
    reason: 'DECISION_UNAVAILABLE',
    runId: '0192f0aa-0000-7000-8000-000000000002',
    provider: null,
    model: null,
  },
};

const DETERMINISTIC = {
  id: 'd_det',
  intentId: 'int_1',
  itemId: 'item_det',
  ruleType: 'required_fields',
  ruleKey: 'summary',
  status: 'open',
  detail: { reason: 'missing_or_empty' },
};

beforeEach(() => {
  routerMocks.params = { intentId: 'int_1' };
  api.intents.mockResolvedValue([INTENT]);
  api.drifts.mockResolvedValue([OPEN, UNEVALUATED, DETERMINISTIC]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function driftItem(name: string): HTMLElement {
  const link = screen.getAllByRole('link', { name: /open item/i }).find((a) => a.getAttribute('href')?.endsWith(name));
  return link!.closest('li')!;
}

describe('IntentDetailPage — semantic drift', () => {
  it('shows rule version, profile version, model, revision and run for an open semantic drift', async () => {
    renderWithClient(<IntentDetailPage />);
    await screen.findAllByText('off-brief@v2');

    const row = within(driftItem('item_open'));
    expect(row.getByText('open')).toBeInTheDocument();
    expect(row.getByText('off-brief@v2')).toBeInTheDocument();
    expect(row.getByText('brief v3')).toBeInTheDocument();
    expect(row.getByText('off_brief')).toBeInTheDocument();
    expect(row.getByText('typesafe / jev-1')).toBeInTheDocument();
    expect(row.getByText('0.91 (threshold 0.8)')).toBeInTheDocument();
    expect(row.getByText('rev_00000000…')).toBeInTheDocument();
    expect(row.getByText('0192f0aa-000…')).toBeInTheDocument();
    // The full fingerprint key is not dumped into the row.
    expect(row.queryByText(OPEN.ruleKey)).toBeNull();
    // No uncertainty banner on a conclusive drift.
    expect(row.queryByText(/not evaluated/i)).toBeNull();
  });

  it('shows the uncertainty state with the recorded reason code and no answer it does not have', async () => {
    renderWithClient(<IntentDetailPage />);
    await screen.findAllByText('off-brief@v2');

    const row = within(driftItem('item_unev'));
    expect(row.getByText('unevaluated')).toBeInTheDocument();
    expect(row.getByText(/not evaluated/i)).toBeInTheDocument();
    expect(row.getByText('DECISION_UNAVAILABLE')).toBeInTheDocument();
    expect(row.getByText(/earlier drift on this item is kept/i)).toBeInTheDocument();
    // No model or answer was recorded, so none is shown.
    expect(row.queryByText('Model')).toBeNull();
    expect(row.queryByText('Answer')).toBeNull();
  });

  it('leaves deterministic drift rows as they were', async () => {
    renderWithClient(<IntentDetailPage />);
    await screen.findAllByText('off-brief@v2');

    const row = within(driftItem('item_det'));
    expect(row.getByText('required_fields')).toBeInTheDocument();
    expect(row.getByText('summary')).toBeInTheDocument();
    expect(row.queryByText('Profile')).toBeNull();
  });

  it('does not report a clean intent when drifts fail to load', async () => {
    api.drifts.mockRejectedValue(new Error('boom'));
    renderWithClient(<IntentDetailPage />);

    expect(await screen.findByText(/could not load drifts/i)).toBeInTheDocument();
    expect(screen.queryByText(/content meets the slo/i)).toBeNull();
  });
});

function SloHarness() {
  const { rows } = useSloRows();
  return <SloTable rows={rows} />;
}

describe('SloTable — unevaluated drift', () => {
  it('keeps unevaluated rows out of the health ratio and counts them separately', async () => {
    api.drifts.mockResolvedValue([UNEVALUATED, OPEN]);
    renderWithClient(<SloHarness />);

    expect(await screen.findByText('1 not evaluated')).toBeInTheDocument();
    // One conclusive row and it is open → 0 %. Counting the unknown row as
    // "not open" would have shown 50 %, i.e. read the outage as half-clean.
    expect(screen.getByText('0%')).toBeInTheDocument();
  });

  it('shows unknown health, never 100 %, when every drift row is unevaluated', async () => {
    // E.g. the provider was down on the first scan after enabling drift.
    api.drifts.mockResolvedValue([UNEVALUATED]);
    renderWithClient(<SloHarness />);

    expect(await screen.findByText('1 not evaluated')).toBeInTheDocument();
    expect(screen.getByText('unknown')).toBeInTheDocument();
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('shows unknown health for a semantic intent with no drift row at all', async () => {
    // The semantic pass off (default) or unavailable records nothing.
    api.drifts.mockResolvedValue([]);
    renderWithClient(<SloHarness />);

    expect(await screen.findByText('unknown')).toBeInTheDocument();
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('shows unknown health when the drifts fail to load', async () => {
    api.intents.mockResolvedValue([{ ...INTENT, rules: [{ type: 'required_fields', fields: ['summary'] }] }]);
    api.drifts.mockRejectedValue(new Error('boom'));
    renderWithClient(<SloHarness />);

    expect(await screen.findByText('unknown')).toBeInTheDocument();
    expect(screen.queryByText('100%')).toBeNull();
  });

  it('keeps a deterministic intent with no drift at 100 %, as before', async () => {
    api.intents.mockResolvedValue([{ ...INTENT, rules: [{ type: 'required_fields', fields: ['summary'] }] }]);
    api.drifts.mockResolvedValue([]);
    renderWithClient(<SloHarness />);

    expect(await screen.findByText('100%')).toBeInTheDocument();
  });
});

describe('sloSummary — dashboard SLO health card', () => {
  const row = (health: number | null, status = 'active'): SloRow => ({
    intent: { ...INTENT, status },
    open: 0,
    total: 0,
    health,
    unevaluated: 0,
  });

  it('leaves unknown intents out of the mean and counts them', () => {
    expect(sloSummary([row(50), row(null), row(null)])).toEqual({ health: 50, unknown: 2 });
  });

  it('is unknown, not healthy, when no active intent has a known health', () => {
    expect(sloSummary([row(null)])).toEqual({ health: null, unknown: 1 });
  });

  it('ignores paused intents', () => {
    expect(sloSummary([row(100), row(null, 'paused'), row(0, 'paused')])).toEqual({ health: 100, unknown: 0 });
  });
});

describe('IntentDetailPage — no drift rows', () => {
  it('does not claim a semantic intent meets the SLO when nothing was recorded', async () => {
    api.drifts.mockResolvedValue([]);
    renderWithClient(<IntentDetailPage />);

    expect(await screen.findByText(/does not show that the semantic rules pass/i)).toBeInTheDocument();
    expect(screen.queryByText(/content meets the slo/i)).toBeNull();
  });

  it('keeps the clean message for an intent without semantic rules', async () => {
    api.intents.mockResolvedValue([{ ...INTENT, rules: [{ type: 'required_fields', fields: ['summary'] }] }]);
    api.drifts.mockResolvedValue([]);
    renderWithClient(<IntentDetailPage />);

    expect(await screen.findByText(/content meets the slo/i)).toBeInTheDocument();
  });
});
