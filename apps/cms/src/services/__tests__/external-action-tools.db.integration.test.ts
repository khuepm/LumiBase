import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, like, sql } from 'drizzle-orm';
import {
  activity,
  agentApprovals,
  agentAutonomyGrants,
  agentToolCalls,
  agentToolSecrets,
  roles,
  settings,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AISecureHarness, type HarnessExecutionResult } from '../ai-harness';
import { McpService, toToolDecision, type McpToolDecision } from '../mcp-service';
import {
  ExternalActionToolRegistry,
  governanceFor,
  type ExternalActionReversibility,
  type ExternalActionRisk,
  type ExternalActionToolDefinition,
} from '../external-action-tools';
import { EXTERNAL_ACTION_AUDIT_PREFIX, type ApprovalDecider } from '../external-action-audit';
import { createHttpEchoTool, HTTP_ECHO_SECRET } from '../external-action-reference-tool';
import { ReviewerService } from '../reviewer-service';
import { ToolSecretService } from '../tool-secret-service';

/**
 * External-action tools, decided and executed against REAL PostgreSQL.
 *
 * Every row that matters is real: runs, tool calls, both approval tables,
 * autonomy grants, the activity log and the encrypted secret. The only stand-in
 * is the remote system: the reference HTTP echo tool is handed an in-memory
 * `fetch`, so "did the external effect happen" is a counter, and no network is
 * touched.
 *
 * What is pinned here:
 * - a high-risk or irreversible tool never executes without a human approval,
 *   at any autonomy level;
 * - only a signed-in user can release such an approval: an API key, an agent
 *   reviewer and an unidentified decider are all refused;
 * - a secret value reaches the handler and nothing else: not the tool result,
 *   not any stored row in any table;
 * - everything is site-scoped: secrets, grants, approvals and audit rows;
 * - the decision through MCP `tools/call` equals the direct harness decision.
 */

const SITE = 'site_ext_a';
const OTHER_SITE = 'site_ext_b';
const ADMIN = 'usr_ext_admin';
const ADMIN_ROLE = 'role_ext_admin';
const OTHER_ADMIN_ROLE = 'role_ext_admin_b';
const AGENT = 'ext-agent';
const CAPABILITY = 'echo:send';
/** Long and distinctive, so a substring scan of the database is meaningful. */
const SECRET_VALUE = 'ext-secret-9f3c7a1e5b2d4860-do-not-leak';
const ENDPOINT = 'https://echo.invalid/v1/echo';

const HUMAN: ApprovalDecider = { kind: 'human', userId: ADMIN };

const keys: KeyProvider = {
  getActiveKey: async () => ({ keyId: 'v1', key: Buffer.alloc(32, 7).toString('base64') }),
  getKey: async () => Buffer.alloc(32, 7).toString('base64'),
  listKeys: async () => [{ keyId: 'v1', status: 'active', algo: 'AES-GCM' }],
};

interface StubRemote {
  calls: Array<{ url: string; authorization: string | undefined; body: string }>;
  fetch: Parameters<typeof createHttpEchoTool>[0]['fetch'];
}

function stubRemote(): StubRemote {
  const calls: StubRemote['calls'] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, authorization: init.headers['authorization'], body: init.body });
      return { ok: true, status: 200, text: async () => init.body };
    },
  };
}

function registryOf(...tools: ExternalActionToolDefinition[]): ExternalActionToolRegistry {
  const registry = new ExternalActionToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

describe.skipIf(!hasDbIntegrationUrl)('external-action tools — DB integration', () => {
  let db: Database;

  function harness(registry: ExternalActionToolRegistry, siteId = SITE): AISecureHarness {
    return new AISecureHarness({ db, siteId, keys, externalTools: registry, enableAgentHarnessAudit: true });
  }

  const requester = (siteId = SITE) => ({
    kind: 'principal' as const,
    ref: { type: 'user' as const, siteId, userId: ADMIN },
  });

  async function call(
    target: AISecureHarness,
    tool: string,
    options: { capabilities?: string[]; siteId?: string; args?: Record<string, unknown> } = {},
  ): Promise<HarnessExecutionResult> {
    return target.execute(
      tool,
      options.args ?? { message: 'hello' },
      options.capabilities ?? [CAPABILITY],
      'external action fixture',
      { agentName: AGENT, requestedByPrincipal: requester(options.siteId ?? SITE) },
    );
  }

  async function setLevel(level: number | null, siteId = SITE): Promise<void> {
    await db
      .delete(agentAutonomyGrants)
      .where(and(eq(agentAutonomyGrants.siteId, siteId), eq(agentAutonomyGrants.agentRole, AGENT)));
    if (level !== null) {
      await db.insert(agentAutonomyGrants).values({ siteId, agentRole: AGENT, capability: CAPABILITY, level });
    }
  }

  async function auditStages(siteId = SITE): Promise<string[]> {
    const rows = await db
      .select({ action: activity.action })
      .from(activity)
      .where(and(eq(activity.siteId, siteId), like(activity.action, `${EXTERNAL_ACTION_AUDIT_PREFIX}%`)))
      .orderBy(activity.createdAt, activity.id);
    return rows.map((row) => row.action.slice(EXTERNAL_ACTION_AUDIT_PREFIX.length));
  }

  beforeAll(async () => {
    db = await connectDbIntegration('external-action-tools');
  });

  const cleanup = async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER_SITE})`);
    await db.delete(users).where(eq(users.id, ADMIN));
  };

  afterAll(async () => {
    if (!db) return;
    await cleanup().catch(() => undefined);
  });

  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE, name: 'External tools A' },
      { organizationId: org, id: OTHER_SITE, name: 'External tools B' },
    ]);
    await db.insert(users).values({ id: ADMIN, email: 'ext-admin@example.dev' });
    await db.insert(roles).values([
      { id: ADMIN_ROLE, siteId: SITE, name: 'Ext Administrator', adminAccess: true, appAccess: true },
      { id: OTHER_ADMIN_ROLE, siteId: OTHER_SITE, name: 'Ext Administrator B', adminAccess: true, appAccess: true },
    ]);
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE },
      { userId: ADMIN, siteId: OTHER_SITE, roleId: OTHER_ADMIN_ROLE },
    ]);
    await new ToolSecretService({ db, siteId: SITE, keys }).set(HTTP_ECHO_SECRET, SECRET_VALUE, ADMIN);
  });

  // -------------------------------------------------------------------------
  // The decision
  // -------------------------------------------------------------------------

  const ALWAYS_APPROVAL: Array<{ label: string; risk: ExternalActionRisk; reversibility: ExternalActionReversibility }> = [
    { label: 'high risk, reversible', risk: 'high', reversibility: 'reversible' },
    { label: 'high risk, irreversible', risk: 'high', reversibility: 'irreversible' },
    { label: 'medium risk, irreversible', risk: 'medium', reversibility: 'irreversible' },
    { label: 'low risk, irreversible', risk: 'low', reversibility: 'irreversible' },
  ];

  for (const shape of ALWAYS_APPROVAL) {
    it(`never executes a ${shape.label} tool without approval, at any autonomy level`, async () => {
      const remote = stubRemote();
      const registry = registryOf(
        createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: shape.risk, reversibility: shape.reversibility }),
      );
      const outcomes: Record<string, string> = {};
      for (const level of [null, 0, 1, 2, 3, 4]) {
        await setLevel(level);
        const result = await call(harness(registry), 'httpEcho');
        outcomes[String(level)] = result.status;
        expect(result.status, `level ${level}`).not.toBe('executed');
      }
      expect(outcomes).toEqual({
        null: 'pending_approval',
        '0': 'denied',
        '1': 'pending_approval',
        '2': 'pending_approval',
        '3': 'pending_approval',
        '4': 'pending_approval',
      });
      expect(remote.calls, 'the remote system was never reached').toHaveLength(0);
    });
  }

  it('lets a reversible tool run autonomously only from the level its risk allows', async () => {
    const outcomes: Record<string, Record<string, string>> = {};
    for (const risk of ['low', 'medium'] as const) {
      outcomes[risk] = {};
      for (const level of [null, 0, 1, 2, 3, 4]) {
        const remote = stubRemote();
        const registry = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk }));
        await setLevel(level);
        const result = await call(harness(registry), 'httpEcho');
        outcomes[risk]![String(level)] = result.status;
        expect(remote.calls.length, `${risk} at ${level}`).toBe(result.status === 'executed' ? 1 : 0);
      }
    }
    expect(outcomes).toEqual({
      // No grant resolves to L1: an external effect is never autonomous by default.
      low: { null: 'pending_approval', '0': 'denied', '1': 'pending_approval', '2': 'executed', '3': 'executed', '4': 'executed' },
      medium: { null: 'pending_approval', '0': 'denied', '1': 'pending_approval', '2': 'pending_approval', '3': 'pending_approval', '4': 'executed' },
    });
  });

  it('runs a read_only tool on capability alone and refuses it without the capability', async () => {
    const remote = stubRemote();
    const registry = registryOf(
      createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, reversibility: 'read_only', capability: 'echo:read' }),
    );
    await setLevel(0);
    const allowed = await call(harness(registry), 'httpEcho', { capabilities: ['echo:read'] });
    expect(allowed.status).toBe('executed');
    const refused = await call(harness(registry), 'httpEcho', { capabilities: ['items:read'] });
    expect(refused).toMatchObject({ status: 'denied', message: 'Insufficient capabilities' });
    expect(remote.calls).toHaveLength(1);
  });

  it('refuses arguments the tool did not declare, before a run or an approval exists', async () => {
    const remote = stubRemote();
    const registry = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: 'high' }));
    const result = await call(harness(registry), 'httpEcho', { args: { message: 'hi', extra: true } });
    expect(result).toMatchObject({ status: 'denied', code: 'VALIDATION' });
    expect(result.runId).toBeUndefined();
    expect(await db.select().from(agentApprovals).where(eq(agentApprovals.siteId, SITE))).toHaveLength(0);
  });

  it('cannot be reached through runSkill or an ungoverned harness', async () => {
    const remote = stubRemote();
    const registry = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch }));
    await setLevel(4);

    const direct = await harness(registry).runSkill('httpEcho', { message: 'hi' });
    expect(direct).toMatchObject({ success: false });
    expect((direct as { error: string }).error).toContain('EXTERNAL_TOOL_UNGOVERNED');

    const ungoverned = new AISecureHarness({ db, siteId: SITE, externalTools: registry });
    const legacy = await ungoverned.execute('httpEcho', { message: 'hi' }, [CAPABILITY]);
    expect(legacy).toMatchObject({ status: 'denied', code: 'EXTERNAL_TOOL_UNGOVERNED' });

    expect(remote.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Who may approve
  // -------------------------------------------------------------------------

  it('releases a parked external action only to a signed-in user', async () => {
    const remote = stubRemote();
    const registry = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: 'high' }));
    await setLevel(4);
    const parked = await call(harness(registry), 'httpEcho');
    expect(parked.status).toBe('pending_approval');

    const [row] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, parked.agentApprovalId!));
    expect(row!.approvalPolicy).toBe('human_required');

    // Each non-human decider holds full capabilities: what refuses them is who
    // they are, not what they may do.
    const nonHuman: Array<ApprovalDecider | undefined> = [{ kind: 'api_key' }, { kind: 'agent' }, undefined];
    for (const decider of nonHuman) {
      const refused = await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], decider);
      expect(refused, `decider ${decider?.kind ?? 'absent'}`).toMatchObject({
        status: 'denied',
        code: 'HUMAN_APPROVAL_REQUIRED',
      });
    }
    expect(remote.calls, 'no refused decision reached the remote system').toHaveLength(0);
    const [stillPending] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, parked.agentApprovalId!));
    expect(stillPending!.status).toBe('pending');

    const approved = await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(approved.status).toBe('executed');
    expect(remote.calls).toHaveLength(1);
    const [decided] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, parked.agentApprovalId!));
    expect(decided).toMatchObject({ status: 'approved', decidedBy: ADMIN });

    // The whole life of the action is on record, the decision before the effect.
    expect(await auditStages()).toEqual(['proposed', 'refused', 'refused', 'refused', 'approved', 'executed']);
  });

  it('keeps the human-only rule when the tool is re-registered with a milder declaration', async () => {
    const remote = stubRemote();
    await setLevel(1);
    const parked = await call(
      harness(registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: 'high' }))),
      'httpEcho',
    );
    const milder = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: 'low' }));
    const refused = await harness(milder).executeApproved(parked.approvalId!, ADMIN, ['admin'], { kind: 'api_key' });
    expect(refused).toMatchObject({ status: 'denied', code: 'HUMAN_APPROVAL_REQUIRED' });
    expect(remote.calls).toHaveLength(0);
  });

  it('refuses an agent reviewer before anything is recorded, even with agent review enabled', async () => {
    const remote = stubRemote();
    const registry = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: 'high' }));
    const parked = await call(harness(registry), 'httpEcho');
    await db.insert(settings).values({ siteId: SITE, key: 'contentOs', value: { agentReview: true } });

    let executorCalled = false;
    const reviewer = new ReviewerService({
      db,
      siteId: SITE,
      execute: async () => {
        executorCalled = true;
        return { executed: true };
      },
    });
    await expect(
      reviewer.decide({
        approvalId: parked.agentApprovalId!,
        reviewerRunId: 'run_reviewer',
        decision: 'approved',
        confidence: 1,
        capabilities: ['admin'],
      }),
    ).rejects.toMatchObject({ code: 'HUMAN_ONLY' });
    expect(executorCalled).toBe(false);
    expect(remote.calls).toHaveLength(0);
  });

  it('records a rejection and leaves nothing executable', async () => {
    const remote = stubRemote();
    const registry = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: 'high' }));
    const parked = await call(harness(registry), 'httpEcho');
    expect(await harness(registry).rejectApproval(parked.approvalId!, ADMIN, HUMAN)).toBe(true);
    const late = await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(late.status).toBe('denied');
    expect(remote.calls).toHaveLength(0);
    expect(await auditStages()).toEqual(['proposed', 'rejected']);
  });

  it('a frozen site refuses an approved external action', async () => {
    const remote = stubRemote();
    const registry = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: 'high' }));
    const parked = await call(harness(registry), 'httpEcho');
    const { KillSwitchService } = await import('../kill-switch-service');
    await new KillSwitchService({ db, siteId: SITE }).activate({ scope: 'site', reason: 'fixture' } as never, ADMIN);
    const result = await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(result.status).toBe('denied');
    expect(result.message).toContain('frozen');
    expect(remote.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  /** Every table in the schema, searched for the plaintext as a substring. */
  async function tablesContaining(needle: string): Promise<string[]> {
    const tables = (await db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    )) as unknown as Array<{ tablename: string }>;
    const hits: string[] = [];
    for (const { tablename } of tables) {
      const found = (await db.execute(
        sql`SELECT 1 FROM ${sql.identifier(tablename)} AS t WHERE t::text LIKE ${`%${needle}%`} LIMIT 1`,
      )) as unknown as unknown[];
      if (found.length > 0) hits.push(tablename);
    }
    return hits;
  }

  it('hands the secret to the handler and to nothing else', async () => {
    const remote = stubRemote();
    const base64 = Buffer.from(SECRET_VALUE).toString('base64');
    // Three handlers that each mishandle the secret in a different way.
    const leaky = (name: string, body: ExternalActionToolDefinition['handler']): ExternalActionToolDefinition => ({
      ...createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, name }),
      handler: body,
    });
    const registry = registryOf(
      createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch }),
      leaky('leakReturn', async (_args, context) => ({
        token: context.secret(HTTP_ECHO_SECRET),
        nested: [{ header: `Bearer ${context.secret(HTTP_ECHO_SECRET)}` }],
        encoded: Buffer.from(context.secret(HTTP_ECHO_SECRET)).toString('base64'),
        [context.secret(HTTP_ECHO_SECRET)]: 'as a key',
      })),
      leaky('leakThrow', async (_args, context) => {
        throw new Error(`remote rejected Authorization: Bearer ${context.secret(HTTP_ECHO_SECRET)}`);
      }),
    );
    await setLevel(4);

    const ok = await call(harness(registry), 'httpEcho');
    const returned = await call(harness(registry), 'leakReturn');
    const thrown = await call(harness(registry), 'leakThrow');

    // The handler did get the real value.
    expect(remote.calls[0]!.authorization).toBe(`Bearer ${SECRET_VALUE}`);
    expect(ok.status).toBe('executed');
    expect(returned.status).toBe('executed');
    expect(thrown.status).toBe('denied');

    // Nothing returned to the caller carries it, raw or encoded.
    const visible = JSON.stringify([ok, returned, thrown]);
    expect(visible).not.toContain(SECRET_VALUE);
    expect(visible).not.toContain(base64);
    expect(visible).toContain(`[secret:${HTTP_ECHO_SECRET}]`);

    // Same through an approval, which stores arguments and a decision trail.
    await setLevel(1);
    const parked = await call(harness(registry), 'leakThrow');
    await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);

    // And nothing persisted carries it: every table, every column.
    expect(await tablesContaining(SECRET_VALUE)).toEqual([]);
    expect(await tablesContaining(base64)).toEqual([]);

    // The audit rows name the secret by reference.
    const rows = await db
      .select({ payload: activity.payload })
      .from(activity)
      .where(and(eq(activity.siteId, SITE), like(activity.action, `${EXTERNAL_ACTION_AUDIT_PREFIX}%`)));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect((row.payload as { secretRefs: string[] }).secretRefs).toEqual([HTTP_ECHO_SECRET]);
    }
  });

  it('a secret that is not configured stops the call before the handler, and the approval stays retryable', async () => {
    const remote = stubRemote();
    const registry = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: 'high' }));
    await new ToolSecretService({ db, siteId: SITE, keys }).delete(HTTP_ECHO_SECRET);

    const parked = await call(harness(registry), 'httpEcho');
    const failed = await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(failed.status).toBe('denied');
    expect(failed.message).toContain('SECRET_MISSING');
    expect(failed.message).toContain(HTTP_ECHO_SECRET);
    expect(remote.calls).toHaveLength(0);

    // Nothing external happened, so the approval is pending again, not `failed`.
    const [row] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, parked.agentApprovalId!));
    expect(row!.status).toBe('pending');

    await new ToolSecretService({ db, siteId: SITE, keys }).set(HTTP_ECHO_SECRET, SECRET_VALUE, ADMIN);
    const retried = await harness(registry).executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(retried.status).toBe('executed');
    expect(remote.calls).toHaveLength(1);
  });

  it('a handler cannot read a secret it did not declare', async () => {
    const registry = registryOf({
      ...createHttpEchoTool({ endpoint: ENDPOINT, fetch: stubRemote().fetch }),
      secrets: [],
      handler: async (_args, context) => ({ value: context.secret(HTTP_ECHO_SECRET) }),
    });
    await setLevel(4);
    const result = await call(harness(registry), 'httpEcho');
    expect(result.status).toBe('denied');
    expect(result.message).toContain('not declared');
  });

  // -------------------------------------------------------------------------
  // Site isolation
  // -------------------------------------------------------------------------

  it('keeps secrets, grants, approvals and audit rows inside their site', async () => {
    const remote = stubRemote();
    const registry = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk: 'low' }));

    // Site A grants L4 and holds the secret; site B has neither.
    await setLevel(4, SITE);
    const onOther = await call(harness(registry, OTHER_SITE), 'httpEcho', { siteId: OTHER_SITE });
    expect(onOther.status, 'site A’s grant does not apply on site B').toBe('pending_approval');

    // Approved on B by a human: site A's secret is not B's.
    const noSecret = await harness(registry, OTHER_SITE).executeApproved(onOther.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(noSecret.status).toBe('denied');
    expect(noSecret.message).toContain('SECRET_MISSING');
    expect(remote.calls).toHaveLength(0);

    // A ciphertext copied across sites does not decrypt there either.
    const [source] = await db.select().from(agentToolSecrets).where(eq(agentToolSecrets.siteId, SITE));
    await db.insert(agentToolSecrets).values({
      siteId: OTHER_SITE,
      name: HTTP_ECHO_SECRET,
      ciphertext: source!.ciphertext,
      keyId: source!.keyId,
    });
    await expect(
      new ToolSecretService({ db, siteId: OTHER_SITE, keys }).resolve([HTTP_ECHO_SECRET]),
    ).rejects.toMatchObject({ code: 'SECRET_UNREADABLE' });
    expect((await new ToolSecretService({ db, siteId: OTHER_SITE, keys }).list()).map((row) => row.name)).toEqual([
      HTTP_ECHO_SECRET,
    ]);

    // An approval parked on B cannot be decided from A.
    const parkedOnOther = await call(harness(registry, OTHER_SITE), 'httpEcho', { siteId: OTHER_SITE });
    const crossSite = await harness(registry, SITE).executeApproved(parkedOnOther.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(crossSite).toMatchObject({ status: 'denied', message: 'Approval not found or already processed' });
    expect(await harness(registry, SITE).rejectApproval(parkedOnOther.approvalId!, ADMIN, HUMAN)).toBe(false);

    // Site A saw none of it.
    expect(await auditStages(SITE)).toEqual([]);
    expect((await auditStages(OTHER_SITE)).filter((stage) => stage === 'proposed')).toHaveLength(2);
    expect(await db.select().from(agentToolCalls).where(eq(agentToolCalls.siteId, SITE))).toHaveLength(0);
    expect(remote.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // MCP parity
  // -------------------------------------------------------------------------

  it('decides the same through MCP tools/call as through the harness directly', async () => {
    const normalize = (decision: McpToolDecision): McpToolDecision => {
      const copy: McpToolDecision = { ...decision };
      // Ids differ per call by construction; what must agree is the decision.
      delete copy.runId;
      for (const key of ['approvalId', 'agentApprovalId', 'legacyApprovalId'] as const) {
        if (copy[key]) copy[key] = '<id>';
      }
      return copy;
    };

    const risks: ExternalActionRisk[] = ['low', 'medium', 'high'];
    const reversibilities: ExternalActionReversibility[] = ['read_only', 'reversible', 'irreversible'];
    let compared = 0;
    for (const risk of risks) {
      for (const reversibility of reversibilities) {
        const remote = stubRemote();
        const registry = registryOf(createHttpEchoTool({ endpoint: ENDPOINT, fetch: remote.fetch, risk, reversibility }));
        const governance = governanceFor({ risk, reversibility });
        for (const level of [null, 0, 1, 2, 3, 4]) {
          await setLevel(level);
          for (const capabilities of [[CAPABILITY], ['items:read'], ['admin'], []]) {
            for (const args of [{ message: 'hi' }, {}, { message: 'hi', extra: 1 }]) {
              const direct = normalize(
                toToolDecision(await call(harness(registry), 'httpEcho', { capabilities, args })),
              );
              const target = harness(registry);
              const service = new McpService({
                listTools: async () => [],
                execute: (name, callArgs, caps, contextMessage) =>
                  target.execute(name, callArgs, caps, contextMessage ?? 'external action fixture', {
                    agentName: AGENT,
                    requestedByPrincipal: requester(),
                  }),
              });
              const response = await service.handle(
                { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'httpEcho', arguments: args } },
                capabilities,
              );
              const result = response!.result as { structuredContent: McpToolDecision; isError: boolean };
              const viaMcp = normalize(result.structuredContent);

              const where = `${risk}/${reversibility} L${level} caps=${capabilities.join('|')} args=${JSON.stringify(args)}`;
              expect(viaMcp, where).toEqual(direct);
              expect(result.isError, where).toBe(direct.status === 'denied');
              if (governance.alwaysRequiresApproval) {
                expect(viaMcp.status, where).not.toBe('executed');
              }
              compared += 1;
            }
          }
        }
      }
    }
    expect(compared).toBe(3 * 3 * 6 * 4 * 3);
  }, 300_000);
});
