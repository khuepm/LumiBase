import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getTableName } from 'drizzle-orm';
import { agentApprovals, aiApprovals } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../../env';
import { createFakeDb, type FakeDb, type Row } from '../../services/__tests__/g1-approval-fake-db';

/**
 * G1 (#453) — a human decision on an agent approval must execute/resume the
 * parked action, not merely flip a status column.
 *
 * Baseline defect: `POST /agent/approvals/:id/decide` updated
 * `agent_approvals` and returned the row without ever invoking the harness,
 * so an approved `deleteCollection` produced a success-shaped response with
 * no side effect and left the run parked.
 *
 * Every assertion here counts SIDE EFFECTS (harness invocations, writes to
 * `ai_approvals`), not just the final approval status — a status-only fix
 * must not make these pass.
 */

// The route must reach the harness to execute an approved action. Spying on
// `executeApproved` lets these tests count real side effects without standing
// up SchemaService/ItemService/LLM — the seam lives here, not in production.
const executeApproved = vi.fn();
const rejectApproval = vi.fn();
vi.mock('../../services/ai-harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/ai-harness')>();
  return {
    ...actual,
    AISecureHarness: class {
      executeApproved = executeApproved;
      rejectApproval = rejectApproval;
    },
  };
});
vi.mock('../../services/item-service-factory', () => ({
  itemServiceForRequest: () => ({}),
}));

// Imported after the mocks above are registered.
const { agentRouter } = await import('../agent');

const AGENT_APPROVALS = getTableName(agentApprovals);
const AI_APPROVALS = getTableName(aiApprovals);

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

function pendingAgentApproval(overrides: Row = {}): Row {
  return {
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
    ...overrides,
  };
}

function pendingLegacyApproval(overrides: Row = {}): Row {
  return {
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
    ...overrides,
  };
}

/** Rows the harness stub commits against, set by `seedFakeDb`. */
let currentAgentRows: Row[] = [];

function seedFakeDb(agentRows: Row[], legacyRows: Row[]): FakeDb {
  currentAgentRows = agentRows;
  const fake = createFakeDb({
    [AGENT_APPROVALS]: agentRows,
    [AI_APPROVALS]: legacyRows,
  });
  // Site scoping is asserted explicitly by the tenant test below; the stub
  // does not interpret `where`, so it applies the tenant predicate itself.
  fake.tables[AGENT_APPROVALS]!.match = (row) => row['siteId'] === 'site_a';
  fake.tables[AI_APPROVALS]!.match = (row) => row['siteId'] === 'site_a';
  // Mirrors the route's compare-and-set guards: only a `pending` row can be
  // claimed or rejected, and only a claimed (`deciding`) row can be released.
  fake.tables[AGENT_APPROVALS]!.updateGuards = {
    deciding: ['pending'],
    rejected: ['pending'],
    pending: ['deciding'],
  };
  return fake;
}

function buildApp(fake: FakeDb, auth: AuthPrincipal): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // `buildAuthorizedHarness` resolves the LLM from the worker env; an empty
  // env is the "no provider configured" case, which is correct here.
  app.use('*', async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (c as any).env = {};
    await next();
  });
  app.use('*', async (c, next) => {
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
  executeApproved.mockReset();
  rejectApproval.mockReset();
  rejectApproval.mockResolvedValue(true);
  // The real harness commits the `pending → approved` transition itself, only
  // after the skill succeeded. The stub stands in for that commit so these
  // route tests observe the same ordering.
  executeApproved.mockImplementation(async () => {
    for (const row of currentAgentRows) {
      if (row['status'] === 'pending') row['status'] = 'approved';
    }
    return { status: 'executed', data: { deleted: true } };
  });
});

describe('G1 — human approval executes the parked action', () => {
  it('executes the stored action exactly once on approve', async () => {
    const fake = seedFakeDb([pendingAgentApproval()], [pendingLegacyApproval()]);

    const res = await decide(fake, { decision: 'approved' });

    expect(res.status).toBe(200);
    expect(executeApproved).toHaveBeenCalledTimes(1);
    // The legacy record carries the stored skill + arguments to execute.
    expect(executeApproved.mock.calls[0]![0]).toBe('legacy_1');
    expect(executeApproved.mock.calls[0]![1]).toBe('usr_admin');
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('approved');
  });

  it('never executes on reject', async () => {
    const fake = seedFakeDb([pendingAgentApproval()], [pendingLegacyApproval()]);

    const res = await decide(fake, { decision: 'rejected' });

    expect(res.status).toBe(200);
    expect(executeApproved).not.toHaveBeenCalled();
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('rejected');
  });

  it('never executes an already-decided approval (no replay)', async () => {
    const fake = seedFakeDb(
      [pendingAgentApproval({ status: 'approved', decidedAt: new Date() })],
      [pendingLegacyApproval({ status: 'approved' })],
    );

    const res = await decide(fake, { decision: 'approved' });

    expect(res.status).toBe(409);
    expect(executeApproved).not.toHaveBeenCalled();
  });

  it('never executes an expired approval', async () => {
    const fake = seedFakeDb(
      [pendingAgentApproval({ expiresAt: new Date(Date.now() - 60_000) })],
      [pendingLegacyApproval()],
    );

    const res = await decide(fake, { decision: 'approved' });

    expect(res.status).toBe(409);
    expect(executeApproved).not.toHaveBeenCalled();
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('pending');
  });

  it('never executes an approval belonging to another tenant', async () => {
    const fake = seedFakeDb([pendingAgentApproval({ siteId: 'site_b' })], [pendingLegacyApproval()]);

    const res = await decide(fake, { decision: 'approved' });

    expect(res.status).toBe(404);
    expect(executeApproved).not.toHaveBeenCalled();
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('pending');
  });

  it('never executes for a caller without approval capability', async () => {
    const fake = seedFakeDb([pendingAgentApproval()], [pendingLegacyApproval()]);

    const res = await decide(fake, { decision: 'approved' }, memberPrincipal);

    expect(res.status).toBe(403);
    expect(executeApproved).not.toHaveBeenCalled();
    expect(fake.tables[AGENT_APPROVALS]!.rows[0]!['status']).toBe('pending');
  });

  it('does not double-execute under concurrent approve requests', async () => {
    const fake = seedFakeDb([pendingAgentApproval()], [pendingLegacyApproval()]);

    const responses = await Promise.all([
      decide(fake, { decision: 'approved' }),
      decide(fake, { decision: 'approved' }),
    ]);

    // Exactly one request wins the pending→approved transition; the loser must
    // not re-run the action (side-effect count, not just final status).
    expect(executeApproved).toHaveBeenCalledTimes(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('reports execution failure instead of a success-shaped response', async () => {
    const fake = seedFakeDb([pendingAgentApproval()], [pendingLegacyApproval()]);
    executeApproved.mockResolvedValue({
      status: 'denied',
      message: 'SCHEMA_SERVICE_NOT_CONFIGURED',
    });

    const res = await decide(fake, { decision: 'approved' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const payload = (await res.json()) as { errors?: Array<{ message: string }> };
    expect(payload.errors?.[0]?.message).toContain('SCHEMA_SERVICE_NOT_CONFIGURED');
  });
});
