// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * Operator recovery surface for quarantined approvals (#453, DoD §2d).
 *
 * A `failed` approval is one whose execution was interrupted after it may
 * already have taken effect, so it deliberately stops being ordinary work: it
 * does not re-run until a human states what they verified. That makes the
 * Studio the only place the recovery exists — and the review's finding was
 * that quarantined approvals had no operator-visible path at all, so a crashed
 * execution was stuck AND invisible.
 *
 * These tests pin the three things that make the surface real: the quarantine
 * is called out, the reason the sweeper recorded is shown (it is what the
 * operator has to act on), and Reopen posts a required reason to the endpoint
 * that records the authorization.
 */

vi.mock('@/lib/api', () => ({
  getActiveToken: () => 'token',
  getActiveSite: () => 'site_1',
}));

import { AgentHarnessPage } from '../agent-harness-page';

const QUARANTINED = {
  id: 'apr_crashed',
  runId: 'run_1',
  subjectType: 'deployment',
  status: 'failed',
  approvalPolicy: 'human',
  requestedByAgent: 'agent_x',
  createdAt: new Date().toISOString(),
  decisionReason:
    'execution was interrupted (claim abandoned); the side effect is unknown. Verify before reopening.',
};

const PENDING = {
  id: 'apr_normal',
  runId: 'run_2',
  subjectType: 'item',
  status: 'pending',
  approvalPolicy: 'human',
  requestedByAgent: 'agent_y',
  createdAt: new Date().toISOString(),
  decisionReason: null,
};

const fetchMock = vi.fn();

function jsonResponse(data: unknown) {
  return { ok: true, json: () => Promise.resolve({ data }) } as Response;
}

beforeEach(() => {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/approvals/apr_crashed/reopen')) {
      return Promise.resolve(jsonResponse({ id: 'apr_crashed', status: 'pending' }));
    }
    if (url.endsWith('/approvals')) return Promise.resolve(jsonResponse([QUARANTINED, PENDING]));
    if (url.endsWith('/memory')) {
      return Promise.resolve(jsonResponse({ memories: [], recentRuns: [], approvedArtifacts: [] }));
    }
    return Promise.resolve(jsonResponse([]));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function openApprovalsTab() {
  render(<AgentHarnessPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Approvals' }));
}

describe('Approvals tab — quarantined recovery', () => {
  it('surfaces the interruption and the reason recorded by the sweeper', async () => {
    await openApprovalsTab();

    // Called out, not just present as a status string in a row.
    expect(await screen.findByText(/interrupted mid-execution/i)).toBeInTheDocument();
    expect(screen.getByText(/quarantined/i)).toBeInTheDocument();
    // The reason drives what a human verifies next, so it must be visible.
    expect(screen.getByText(/the side effect is unknown/i)).toBeInTheDocument();
  });

  it('offers Reopen only for a quarantined approval', async () => {
    await openApprovalsTab();
    // Two approvals are listed, but a pending one is ordinary work and must
    // not get a recovery affordance.
    const buttons = await screen.findAllByRole('button', { name: /reopen/i });
    expect(buttons).toHaveLength(1);
  });

  it('refuses to reopen without a reason, and never calls the endpoint', async () => {
    await openApprovalsTab();
    fireEvent.click(await screen.findByRole('button', { name: /^reopen$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /confirm reopen/i }));

    expect(await screen.findByText(/a reason is required/i)).toBeInTheDocument();
    // The reason IS the authorization, so an empty one must not reach the API.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/reopen'))).toBe(false);
  });

  it('POSTs the reason to the reopen endpoint and reloads', async () => {
    await openApprovalsTab();
    fireEvent.click(await screen.findByRole('button', { name: /^reopen$/i }));

    fireEvent.change(await screen.findByLabelText(/what did you verify/i), {
      target: { value: 'checked Vercel — no deployment was created' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /confirm reopen/i }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/approvals/apr_crashed/reopen'));
      expect(call).toBeDefined();
      const init = call?.[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({
        reason: 'checked Vercel — no deployment was created',
      });
    });

    // The list is refetched so the row leaves the quarantine state.
    await waitFor(() => {
      const listCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/approvals'));
      expect(listCalls.length).toBeGreaterThan(1);
    });
  });
});
