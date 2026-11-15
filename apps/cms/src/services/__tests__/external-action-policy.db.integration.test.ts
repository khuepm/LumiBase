import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, like, sql } from 'drizzle-orm';
import {
  activity,
  agentApprovals,
  agentAutonomyGrants,
  constitutions,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import type { ExternalActionPolicy } from '@lumibase/contracts/platform';
import type { KeyProvider } from '@lumibase/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AISecureHarness, type HarnessExecutionResult } from '../ai-harness';
import { ConstitutionService, type ConstitutionEvaluator } from '../constitution-service';
import { McpService, toToolDecision, type McpToolDecision } from '../mcp-service';
import { ExternalActionToolRegistry, type ExternalActionRisk } from '../external-action-tools';
import { EXTERNAL_ACTION_AUDIT_PREFIX, type ApprovalDecider } from '../external-action-audit';
import { createHttpEchoTool, HTTP_ECHO_SECRET } from '../external-action-reference-tool';
import { ToolSecretService } from '../tool-secret-service';

/**
 * Pre-execution policy of external-action tools, against REAL PostgreSQL.
 *
 * The constitution versions, runs, approvals, grants and audit rows are real.
 * The remote system is a counter (the reference echo tool gets an in-memory
 * `fetch`), so "the effect happened" is observable and nothing is sent.
 *
 * Pinned here:
 * - a tool whose policy requires a constitution never runs, and never parks an
 *   approval, on a site without an active one (fail closed);
 * - a blocking violation refuses the call at every autonomy level;
 * - a violation of an evaluator marked `require_approval` parks the call for a
 *   human even where the autonomy level would have run it;
 * - the policy is evaluated again before an approved call executes, and a
 *   constitution deactivated in between stops it without consuming the approval;
 * - every decision is audited with the evaluator verdicts and the hash;
 * - a tool without a policy behaves as it always did;
 * - MCP `tools/call` decides exactly as the harness does.
 */

const SITE = 'site_pol_a';
const ADMIN = 'usr_pol_admin';
const ADMIN_ROLE = 'role_pol_admin';
const AGENT = 'pol-agent';
const CAPABILITY = 'echo:send';
const ENDPOINT = 'https://echo.invalid/v1/echo';
const HUMAN: ApprovalDecider = { kind: 'human', userId: ADMIN };

const keys: KeyProvider = {
  getActiveKey: async () => ({ keyId: 'v1', key: Buffer.alloc(32, 9).toString('base64') }),
  getKey: async () => Buffer.alloc(32, 9).toString('base64'),
  listKeys: async () => [{ keyId: 'v1', status: 'active', algo: 'AES-GCM' }],
};

/** Refuses a token-looking message; asks a human about one without "please". */
const EVALUATORS: ConstitutionEvaluator[] = [
  { id: 'intent-linked', type: 'rule', blocking: true, rule: { field: 'intentRef', op: 'required' } },
  { id: 'no-token', type: 'rule', blocking: true, rule: { field: 'message', op: 'not_contains', value: 'tok_' } },
  {
    id: 'polite',
    type: 'rule',
    blocking: true,
    onViolation: 'require_approval',
    rule: { field: 'message', op: 'contains', value: 'please' },
  },
  { id: 'short', type: 'rule', blocking: false, rule: { field: 'message', op: 'max_length', value: 40 } },
];

/** The record maps the run's intent to the field the constitution reads. */
const POLICY: ExternalActionPolicy = {
  constitution: 'required',
  record: (args, facts) => ({ message: args['message'], intentRef: facts.intentId }),
};

interface Remote {
  calls: number;
  fetch: Parameters<typeof createHttpEchoTool>[0]['fetch'];
}

function stubRemote(): Remote {
  const remote: Remote = {
    calls: 0,
    fetch: async (_url, init) => {
      remote.calls += 1;
      return { ok: true, status: 200, text: async () => init.body };
    },
  };
  return remote;
}

function registryWith(
  remote: Remote,
  options: { risk?: ExternalActionRisk; policy?: ExternalActionPolicy | null } = {},
): ExternalActionToolRegistry {
  const registry = new ExternalActionToolRegistry();
  const tool = createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: options.risk ?? 'low' });
  const policy = options.policy === undefined ? POLICY : options.policy;
  registry.register(policy ? { ...tool, policy } : tool);
  return registry;
}

describe.skipIf(!hasDbIntegrationUrl)('external-action policy — DB integration', () => {
  let db: Database;

  const harness = (registry: ExternalActionToolRegistry) =>
    new AISecureHarness({ db, siteId: SITE, keys, externalTools: registry, enableAgentHarnessAudit: true });

  const requester = () => ({ kind: 'principal' as const, ref: { type: 'user' as const, siteId: SITE, userId: ADMIN } });

  const call = (
    target: AISecureHarness,
    message: string,
    options: { intentId?: string | null; capabilities?: string[] } = {},
  ): Promise<HarnessExecutionResult> =>
    target.execute('httpEcho', { message }, options.capabilities ?? [CAPABILITY], 'policy fixture', {
      agentName: AGENT,
      requestedByPrincipal: requester(),
      ...(options.intentId === null ? {} : { intentId: options.intentId ?? 'intent_pol' }),
    });

  async function setLevel(level: number | null): Promise<void> {
    await db
      .delete(agentAutonomyGrants)
      .where(and(eq(agentAutonomyGrants.siteId, SITE), eq(agentAutonomyGrants.agentRole, AGENT)));
    if (level !== null) {
      await db.insert(agentAutonomyGrants).values({ siteId: SITE, agentRole: AGENT, capability: CAPABILITY, level });
    }
  }

  async function activate(evaluators: ConstitutionEvaluator[] = EVALUATORS): Promise<string> {
    const service = new ConstitutionService({ db, siteId: SITE });
    const draft = await service.createDraft(evaluators, ADMIN);
    await service.activate(draft.id, ADMIN);
    return draft.hash;
  }

  async function deactivate(): Promise<void> {
    await db
      .update(constitutions)
      .set({ status: 'archived' })
      .where(and(eq(constitutions.siteId, SITE), eq(constitutions.status, 'active')));
  }

  async function auditRows(): Promise<Array<{ stage: string; payload: Record<string, unknown> }>> {
    const rows = await db
      .select({ action: activity.action, payload: activity.payload })
      .from(activity)
      .where(and(eq(activity.siteId, SITE), like(activity.action, `${EXTERNAL_ACTION_AUDIT_PREFIX}%`)))
      .orderBy(activity.createdAt, activity.id);
    return rows.map((row) => ({
      stage: row.action.slice(EXTERNAL_ACTION_AUDIT_PREFIX.length),
      payload: row.payload as Record<string, unknown>,
    }));
  }

  const cleanup = async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(eq(users.id, ADMIN));
  };

  beforeAll(async () => {
    db = await connectDbIntegration('external-action-policy');
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup().catch(() => undefined);
  });

  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values({ organizationId: org, id: SITE, name: 'Policy A' });
    await db.insert(users).values({ id: ADMIN, email: 'pol-admin@example.dev' });
    await db.insert(roles).values({ id: ADMIN_ROLE, siteId: SITE, name: 'Pol Admin', adminAccess: true, appAccess: true });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE });
    await new ToolSecretService({ db, siteId: SITE, keys }).set(HTTP_ECHO_SECRET, 'pol-secret-value', ADMIN);
  });

  it('fails closed: no active constitution, no run of the tool and no approval, at any level', async () => {
    const remote = stubRemote();
    const registry = registryWith(remote, { risk: 'high' });
    for (const level of [null, 1, 2, 4]) {
      await setLevel(level);
      const result = await call(harness(registry), 'please send');
      expect(result, `level ${level}`).toMatchObject({ status: 'denied', code: 'CONSTITUTION_REQUIRED' });
    }
    expect(remote.calls).toBe(0);
    expect(await db.select().from(agentApprovals).where(eq(agentApprovals.siteId, SITE))).toHaveLength(0);
    const audit = await auditRows();
    expect(audit.map((row) => row.stage)).toEqual(['refused', 'refused', 'refused', 'refused']);
    expect(audit[0]!.payload).toMatchObject({
      code: 'CONSTITUTION_REQUIRED',
      policy: { outcome: 'refuse', code: 'CONSTITUTION_REQUIRED', constitutionHash: null, evaluators: [] },
    });
  });

  it('refuses a blocking violation at every level, and audits which evaluator refused', async () => {
    const hash = await activate();
    const remote = stubRemote();
    const registry = registryWith(remote);
    for (const level of [1, 2, 4]) {
      await setLevel(level);
      const leaked = await call(harness(registry), 'please use tok_123');
      expect(leaked, `level ${level}`).toMatchObject({ status: 'denied', code: 'CONSTITUTION_VIOLATION' });
      expect(leaked.message).toContain('no-token');
    }
    await setLevel(4);
    const noIntent = await call(harness(registry), 'please send', { intentId: null });
    expect(noIntent).toMatchObject({ status: 'denied', code: 'CONSTITUTION_VIOLATION' });
    expect(noIntent.message).toContain('intent-linked');
    expect(remote.calls).toBe(0);

    const [first] = await auditRows();
    expect(first!.payload).toMatchObject({ code: 'CONSTITUTION_VIOLATION', constitutionHash: hash });
    expect((first!.payload['policy'] as { evaluators: unknown[] }).evaluators).toContainEqual({
      id: 'no-token',
      status: 'fail',
      blocking: true,
    });
    // The audit row names evaluators; it never quotes the call.
    expect(JSON.stringify(first!.payload)).not.toContain('tok_123');
  });

  it('runs a passing call where the autonomy level allows it, with the verdict on record', async () => {
    const hash = await activate();
    const remote = stubRemote();
    await setLevel(2);
    const result = await call(harness(registryWith(remote)), 'please send it');
    expect(result.status).toBe('executed');
    expect(remote.calls).toBe(1);
    const [executed] = await auditRows();
    expect(executed).toMatchObject({
      stage: 'executed',
      payload: { constitutionHash: hash, policy: { outcome: 'pass', constitutionHash: hash } },
    });
  });

  it('routes a require_approval violation to a human even at L4, and re-checks on approval', async () => {
    await activate();
    const remote = stubRemote();
    const registry = registryWith(remote);
    await setLevel(4);
    const parked = await call(harness(registry), 'send it now');
    expect(parked.status).toBe('pending_approval');
    expect(remote.calls).toBe(0);
    const [row] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, parked.agentApprovalId!));
    expect(row!.approvalPolicy).toBe('human_required');

    const refused = await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], { kind: 'api_key' });
    expect(refused).toMatchObject({ status: 'denied', code: 'HUMAN_APPROVAL_REQUIRED' });

    const approved = await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(approved.status).toBe('executed');
    expect(remote.calls).toBe(1);
    const audit = await auditRows();
    expect(audit.map((entry) => entry.stage)).toEqual(['proposed', 'refused', 'approved', 'executed']);
    expect(audit[0]!.payload).toMatchObject({ policy: { outcome: 'require_approval' } });
    expect(audit[2]!.payload).toMatchObject({ policy: { outcome: 'require_approval' } });
  });

  it('a constitution deactivated after the proposal stops the approved call and keeps the approval', async () => {
    const hash = await activate();
    const remote = stubRemote();
    const registry = registryWith(remote, { risk: 'high' });
    await setLevel(1);
    const parked = await call(harness(registry), 'please send');
    expect(parked.status).toBe('pending_approval');

    await deactivate();
    const stopped = await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(stopped).toMatchObject({ status: 'denied', code: 'CONSTITUTION_REQUIRED' });
    expect(remote.calls).toBe(0);
    const [stillPending] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, parked.agentApprovalId!));
    expect(stillPending!.status).toBe('pending');

    // The same rules activated again (a new version with the same hash): the
    // approval can now be decided.
    expect(await activate()).toBe(hash);
    const approved = await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(approved.status).toBe('executed');
    expect(remote.calls).toBe(1);
    expect((await auditRows()).map((entry) => entry.stage)).toEqual(['proposed', 'refused', 'approved', 'executed']);
  });

  it('refuses a tool bound to other constitution hashes', async () => {
    const hash = await activate();
    const remote = stubRemote();
    await setLevel(4);
    const other = `sha256:${'f'.repeat(64)}`;
    const bound = await call(
      harness(registryWith(remote, { policy: { ...POLICY, constitutionHashes: [other] } })),
      'please send',
    );
    expect(bound).toMatchObject({ status: 'denied', code: 'CONSTITUTION_NOT_ACCEPTED' });
    const accepted = await call(
      harness(registryWith(remote, { policy: { ...POLICY, constitutionHashes: [other, hash] } })),
      'please send',
    );
    expect(accepted.status).toBe('executed');
    expect(remote.calls).toBe(1);
  });

  it('leaves a tool without a policy exactly as it was, even under a strict constitution', async () => {
    await activate();
    const remote = stubRemote();
    await setLevel(2);
    const result = await call(harness(registryWith(remote, { policy: null })), 'tok_ and no intent', { intentId: null });
    expect(result.status).toBe('executed');
    expect(remote.calls).toBe(1);
    const [executed] = await auditRows();
    expect(executed!.payload).not.toHaveProperty('policy');
  });

  it('decides the same through MCP tools/call as through the harness directly', async () => {
    const normalize = (decision: McpToolDecision): McpToolDecision => {
      const copy: McpToolDecision = { ...decision };
      delete copy.runId;
      for (const key of ['approvalId', 'agentApprovalId', 'legacyApprovalId'] as const) {
        if (copy[key]) copy[key] = '<id>';
      }
      return copy;
    };
    let compared = 0;
    for (const state of ['none', 'active'] as const) {
      await deactivate();
      if (state === 'active') await activate();
      for (const risk of ['low', 'high'] as const) {
        const remote = stubRemote();
        const registry = registryWith(remote, { risk });
        for (const level of [null, 0, 2, 4]) {
          await setLevel(level);
          for (const message of ['please send', 'send it', 'please tok_1']) {
            const direct = normalize(toToolDecision(await call(harness(registry), message)));
            const target = harness(registry);
            const service = new McpService({
              listTools: async () => [],
              execute: (name, callArgs, caps, contextMessage) =>
                target.execute(name, callArgs, caps, contextMessage ?? 'policy fixture', {
                  agentName: AGENT,
                  requestedByPrincipal: requester(),
                  intentId: 'intent_pol',
                }),
            });
            const response = await service.handle(
              { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'httpEcho', arguments: { message } } },
              [CAPABILITY],
            );
            const result = response!.result as { structuredContent: McpToolDecision; isError: boolean };
            const where = `${state} ${risk} L${level} "${message}"`;
            expect(normalize(result.structuredContent), where).toEqual(direct);
            expect(result.isError, where).toBe(direct.status === 'denied');
            if (state === 'none') expect(direct.status, where).toBe('denied');
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(2 * 2 * 4 * 3);
  }, 300_000);
});
