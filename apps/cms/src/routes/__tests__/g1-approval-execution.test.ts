import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getTableName } from 'drizzle-orm';
import {
  activity,
  agentApprovals,
  agentFreezes,
  agentGoals,
  agentRuns,
  agentToolCalls,
  agentTools,
  aiApprovals,
  settings,
} from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../../env';
import { createFakeDb, type FakeDb, type Row } from '../../services/__tests__/g1-approval-fake-db';

/**
 * G1 (#453) — a human decision on an agent approval must execute/resume the
 * parked action, not merely flip a status column.
 *
 * These tests run the REAL route through the REAL harness. Only the leaf
 * services are stubbed, so the spy sits at the service boundary where the side
 * effect actually happens.
 *
 * That seam matters: an earlier version of this suite mocked `AISecureHarness`
 * itself and passed while the route was answering 409 to every approve — the
 * route claimed the row, and the harness then refused it for not being
 * `pending`. Counting calls on a mocked harness proves nothing about mutations,
 * so every assertion here counts real `SchemaService` invocations.
 */

const T = (table: unknown) => getTableName(table as never);
const AGENT_APPROVALS = T(agentApprovals);
const AI_APPROVALS = T(aiApprovals);

/** The side effect under test: the skill the approval has stored. */
const deleteCollection = vi.fn();

vi.mock('../../services/schema-service', () => ({
  SchemaService: class {
    deleteCollection = deleteCollection;
  },
}));

// The harness touches assorted ItemService methods for provenance/coalescing;
// none of them are what these tests assert on.
vi.mock('../../services/item-service-factory', () => ({
  itemServiceForRequest: () => new Proxy({}, { get: () => async () => undefined }),
}));

const { agentRouter } = await import('../agent');

const adminPrincipal: AuthPrincipal = {
  userId: 'usr_admin',
  email: 'admin@example.com',
  roles: ['admin'],
  raw: {},
};

const memberPrincipal: AuthPrincipal = {
  userId: 'usr_member',
  email: 'member@example.com',
  roles: ['member'],
  raw: {},
};

function seedFakeDb(agentOverrides: Row = {}, legacyOverrides: Row = {}): FakeDb {
  const fake = createFakeDb({
    [AGENT_APPROVALS]: [{
      id: 'appr_1',
      siteId: 'site_a',
      runId: 'run_1',
      legacyApprovalId: 'legacy_1',
      subjectType: 'tool_call',
      subjectId: 'tc_1',
      kind: 'approval',
      status: 'pending',
      approvalPolicy: 'human',
      requestedByAgent: 'lumibase-copilot',
      expiresAt: null,
      decidedAt: null,
      decidedBy: null,
      createdAt: new Date(Date.now() - 1000),
      ...agentOverrides,
    }],
    [AI_APPROVALS]: [{
      id: 'legacy_1',
      siteId: 'site_a',
      skillName: 'deleteCollection',
      arguments: { name: 'posts' },
      status: 'pending',
      context: null,
      agentName: 'lumibase-copilot',
      decidedAt: null,
      decidedBy: null,
      createdAt: new Date(Date.now() - 1000),
      ...legacyOverrides,
    }],
    [T(agentRuns)]: [{
      id: 'run_1', siteId: 'site_a', goalId: 'goal_1', status: 'awaiting_approval', metrics: {},
    }],
    [T(agentGoals)]: [{ id: 'goal_1', siteId: 'site_a', parentGoalId: null }],
    [T(agentToolCalls)]: [{ id: 'tc_1', siteId: 'site_a', runId: 'run_1', toolName: 'deleteCollection' }],
    [T(agentFreezes)]: [],
    [T(activity)]: [],
    [T(settings)]: [],
    [T(agentTools)]: [],
  });

  // Tenant scoping is asserted explicitly by its own test below; the stub does
  // not interpret `where`, so it applies the predicate itself.
  fake.tables[AGENT_APPROVALS]!.match = (row) => row['siteId'] === 'site_a';
  fake.tables[AI_APPROVALS]!.match = (row) => row['siteId'] === 'site_a';

  // Mirrors the real compare-and-set guards, so a serialization assertion is
  // meaningful rather than accidentally true.
  fake.tables[AGENT_APPROVALS]!.updateGuards = {
    deciding: ['pending'],
    rejected: ['pending'],
    pending: ['deciding'],
    approved: ['deciding'],
  };
  fake.tables[AI_APPROVALS]!.updateGuards = {
    approved: ['pending'],
    rejected: ['pending'],
  };
  return fake;
}

function buildApp(fake: FakeDb, auth: AuthPrincipal): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    // An empty worker env is the "no LLM provider configured" case, which is
    // correct for a schema skill.
    (c as never as { env: Record<string, unknown> }).env = {};
    c.set('auth', auth);
    c.set('db', fake.db);
    c.set('siteId', 'site_a');
    c.set('runtime', { cache: undefined, queue: undefined, keys: undefined } as never);
    c.set('requestId', 'req_1');
    await next();
  });
  app.route('/agent', agentRouter);
  return app;
}

async function decide(fake: FakeDb, body: Row, auth: AuthPrincipal = adminPrincipal) {
  return buildApp(fake, auth).request('/agent/approvals/appr_1/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  deleteCollection.mockReset();
  deleteCollection.mockResolvedValue({ deleted: true });
});

describe('G1 — human approval executes the parked action', () => {
  it('runs the stored action exactly once on approve', async () => {
    const fake = seedFakeDb();

    const res = await decide(fake, { decision: 'approved' });

    expect(res.status).toBe(200);
    // The real service was called — a mutation, not a status flip.
    expect(deleteCollection).toHaveBeenCalledTimes(1);
    expect(deleteCollection).toHaveBeenCalledWith('posts');
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('approved');
    expect(fake.tables[AI_APPROVALS]!.rows[0]!['status']).toBe('approved');
  });

  it('never runs the action on reject', async () => {
    const fake = seedFakeDb();

    const res = await decide(fake, { decision: 'rejected' });

    expect(res.status).toBe(200);
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('rejected');
  });

  it('never replays an already-decided approval', async () => {
    const fake = seedFakeDb(
      { status: 'approved', decidedAt: new Date() },
      { status: 'approved' },
    );

    const res = await decide(fake, { decision: 'approved' });

    expect(res.status).toBe(409);
    expect(deleteCollection).not.toHaveBeenCalled();
  });

  it('never runs the action for an expired approval', async () => {
    const fake = seedFakeDb({ expiresAt: new Date(Date.now() - 60_000) });

    const res = await decide(fake, { decision: 'approved' });

    expect(res.status).toBe(409);
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('pending');
  });

  it('never runs the action for another tenant', async () => {
    const fake = seedFakeDb({ siteId: 'site_b' });

    const res = await decide(fake, { decision: 'approved' });

    expect(res.status).toBe(404);
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('pending');
  });

  it('never runs the action without the approval capability', async () => {
    const fake = seedFakeDb();

    const res = await decide(fake, { decision: 'approved' }, memberPrincipal);

    expect(res.status).toBe(403);
    expect(deleteCollection).not.toHaveBeenCalled();
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('pending');
  });

  it('runs the action once under concurrent approves', async () => {
    const fake = seedFakeDb();

    const responses = await Promise.all([
      decide(fake, { decision: 'approved' }),
      decide(fake, { decision: 'approved' }),
    ]);

    // Side-effect count, not final status: exactly one request may mutate.
    expect(deleteCollection).toHaveBeenCalledTimes(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(1);
  });

  it('runs the action once under a concurrent approve and reject', async () => {
    const fake = seedFakeDb();

    const [approve, reject] = await Promise.all([
      decide(fake, { decision: 'approved' }),
      decide(fake, { decision: 'rejected' }),
    ]);

    // Whoever loses must not leave a second mutation behind, and the two
    // records must not disagree about the outcome.
    expect(deleteCollection.mock.calls.length).toBeLessThanOrEqual(1);
    const statuses = [approve.status, reject.status].sort();
    expect(statuses).toEqual([200, 409]);
    const agentStatus = fake.tables[AGENT_APPROVALS]!.rows[0]!['status'];
    expect(['approved', 'rejected']).toContain(agentStatus);
    expect(fake.tables[AI_APPROVALS]!.rows[0]!['status']).toBe(agentStatus);
  });

  it('reports a failing skill instead of a success-shaped response', async () => {
    const fake = seedFakeDb();
    deleteCollection.mockRejectedValue(new Error('SCHEMA_BOOM'));

    const res = await decide(fake, { decision: 'approved' });

    expect(res.status).toBe(409);
    const payload = (await res.json()) as { errors?: Array<{ message: string }> };
    expect(payload.errors?.[0]?.message).toContain('SCHEMA_BOOM');
    // The claim is released, so the approval stays actionable.
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('pending');
  });

  it('leaves no approval stranded in `deciding` when the skill throws', async () => {
    const fake = seedFakeDb();
    deleteCollection.mockRejectedValue(new Error('boom'));

    await decide(fake, { decision: 'approved' });

    // A stranded `deciding` row disappears from Mission Control's pending
    // inbox, so it must never be the resting state of a failed execution.
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).not.toBe('deciding');
  });
});
