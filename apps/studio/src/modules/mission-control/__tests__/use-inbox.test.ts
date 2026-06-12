import { describe, expect, it } from 'vitest';
import { buildCounts, buildEntries, diffNewEntries, entryLabel } from '../use-inbox';
import type { AgentApproval, AgentIncident, ContentIntent, StagedVeto } from '../api';

/**
 * Unit tests for the shared inbox source (content-os-ui task 1.3).
 *
 * **Validates: Requirements 3.5, 6.1**
 */

const NOW = Date.parse('2026-01-01T12:00:00Z');

function approval(over: Partial<AgentApproval> = {}): AgentApproval {
  return {
    id: 'apr_1',
    runId: 'run_1',
    subjectType: 'tool_call',
    subjectId: 'tc_1',
    status: 'pending',
    kind: 'approval',
    autoCommitAt: null,
    requestedByAgent: 'writer',
    approverType: 'human',
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  };
}

function staged(over: Partial<StagedVeto> = {}): StagedVeto {
  return {
    approvalId: 'veto_1',
    autoCommitAt: new Date(NOW + 60 * 60_000).toISOString(),
    collection: 'articles',
    itemId: 'item_1',
    agentRole: 'writer',
    patch: { title: 'Agent title' },
    ...over,
  };
}

function incident(over: Partial<AgentIncident> = {}): AgentIncident {
  return {
    id: 'inc_1',
    agentRole: 'writer',
    capability: 'items:write',
    source: 'eval_fail',
    severity: 'medium',
    runId: null,
    detail: {},
    createdAt: new Date(NOW).toISOString(),
    ...over,
  };
}

function intent(over: Partial<ContentIntent> = {}): ContentIntent {
  return {
    id: 'int_1',
    name: 'articles-fresh',
    collection: 'articles',
    rules: [],
    schedule: '0 * * * *',
    autonomyCap: 2,
    status: 'error',
    statusReason: 'circuit breaker',
    ...over,
  };
}

describe('buildEntries', () => {
  it('sorts veto deadlines above approvals, high incidents above both backlogs', () => {
    const entries = buildEntries(
      [approval()],
      [staged()],
      [incident({ severity: 'high', id: 'inc_high' })],
      [intent()],
      NOW,
    );
    expect(entries.map((e) => e.kind)).toEqual(['veto', 'incident', 'approval', 'intent_error']);
  });

  it('sorts sooner auto-commit deadlines first', () => {
    const entries = buildEntries(
      [],
      [
        staged({ approvalId: 'veto_late', autoCommitAt: new Date(NOW + 4 * 60 * 60_000).toISOString() }),
        staged({ approvalId: 'veto_soon', autoCommitAt: new Date(NOW + 10 * 60_000).toISOString() }),
      ],
      [],
      [],
      NOW,
    );
    expect(entries.map((e) => e.id)).toEqual(['veto:veto_soon', 'veto:veto_late']);
  });

  it('assigns stable ids of the form <kind>:<sourceId>', () => {
    const entries = buildEntries([approval()], [staged()], [incident()], [intent()], NOW);
    expect(entries.map((e) => e.id).sort()).toEqual([
      'approval:apr_1',
      'incident:inc_1',
      'intent_error:int_1',
      'veto:veto_1',
    ]);
  });

  it('skips non-pending approvals, veto-kind approvals and healthy intents', () => {
    const entries = buildEntries(
      [approval({ status: 'approved' }), approval({ id: 'apr_veto', kind: 'veto' })],
      [],
      [],
      [intent({ status: 'active' })],
      NOW,
    );
    expect(entries).toEqual([]);
  });
});

describe('buildCounts', () => {
  it('counts per kind and finds the nearest auto-commit deadline', () => {
    const soon = new Date(NOW + 10 * 60_000).toISOString();
    const entries = buildEntries(
      [approval()],
      [
        staged({ approvalId: 'veto_late', autoCommitAt: new Date(NOW + 4 * 60 * 60_000).toISOString() }),
        staged({ approvalId: 'veto_soon', autoCommitAt: soon }),
      ],
      [incident()],
      [intent()],
      NOW,
    );
    expect(buildCounts(entries)).toEqual({
      total: 5,
      approvals: 1,
      staged: 2,
      incidents: 1,
      intentErrors: 1,
      nearestAutoCommitAt: soon,
    });
  });

  it('reports zero counts and null deadline for an empty inbox', () => {
    expect(buildCounts([])).toEqual({
      total: 0,
      approvals: 0,
      staged: 0,
      incidents: 0,
      intentErrors: 0,
      nearestAutoCommitAt: null,
    });
  });
});

describe('diffNewEntries / entryLabel (Req 14.5, 14.2)', () => {
  it('returns only entries missing from the seen set', () => {
    const entries = buildEntries([approval()], [staged()], [], [], NOW);
    const seen = new Set(['veto:veto_1']);
    expect(diffNewEntries(seen, entries).map((e) => e.id)).toEqual(['approval:apr_1']);
    expect(diffNewEntries(new Set(entries.map((e) => e.id)), entries)).toEqual([]);
  });

  it('labels every kind with its decision context', () => {
    const entries = buildEntries([approval()], [staged()], [incident()], [intent()], NOW);
    const labels = Object.fromEntries(entries.map((e) => [e.kind, entryLabel(e)]));
    expect(labels.veto).toMatch(/articles\/item_1.*veto window/i);
    expect(labels.approval).toMatch(/tool_call.*writer/);
    expect(labels.incident).toMatch(/medium.*eval_fail.*writer/);
    expect(labels.intent_error).toMatch(/articles-fresh.*error/);
  });
});
