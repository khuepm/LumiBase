import {
  agentApprovals,
  agentGoals,
  agentRuns,
  type Database,
} from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { agentApprovalLatency, agentApprovalsTotal } from '../services/agent-metrics';
import { AGENT_RUNS_QUEUE, type AgentRunJobPayload } from '../services/agent-run-worker';
import { AgentArtifactService } from '../services/agent-artifact-service';
import { AgentEvaluationService } from '../services/agent-evaluation-service';
import { AgentMemoryService } from '../services/agent-memory-service';
import { AgentRunService } from '../services/agent-run-service';
import { CORE_SKILLS } from '../services/ai-harness';
import { ToolRegistryService } from '../services/tool-registry-service';

export const agentRouter = new Hono<AppEnv>();

const createGoalSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  source: z.enum(['user', 'flow', 'api', 'schedule']).default('api'),
  assigneeAgent: z.string().default('lumibase-copilot'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  successCriteria: z.record(z.unknown()).default({}),
  /** `async` enqueues a run via the QueueProvider and returns immediately (Req 3.2). */
  execution: z.enum(['sync', 'async']).default('sync'),
  /** Skill to execute when `execution: 'async'`. */
  task: z
    .object({
      skillName: z.string().min(1).max(120),
      arguments: z.record(z.unknown()).default({}),
    })
    .optional(),
  budget: z.record(z.unknown()).default({}),
});

const artifactSchema = z.object({
  runId: z.string().min(1),
  type: z.enum(['schema_diff', 'page_spec', 'component_spec', 'seed_data', 'api_spec', 'prompt', 'migration']),
  title: z.string().min(1).max(200),
  target: z.string().optional(),
  content: z.record(z.unknown()),
});

const memorySchema = z.object({
  scope: z.string().min(1).max(40),
  scopeId: z.string().optional(),
  sourceType: z.string().min(1).max(80),
  sourceId: z.string().optional(),
  content: z.string().min(1).max(8000),
  confidence: z.number().int().min(0).max(100).optional(),
});

const generateAppSchema = z.object({
  collections: z.array(z.string().min(1)).default(['products', 'orders', 'customers']),
  targetApp: z.string().min(1).default('storefront'),
  constraints: z.record(z.unknown()).default({}),
  budget: z.record(z.unknown()).default({ maxToolCalls: 20, timeoutMs: 30000 }),
  approvalPolicy: z.string().default('before_commit'),
});

agentRouter.get('/goals', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const rows = await db
    .select()
    .from(agentGoals)
    .where(eq(agentGoals.siteId, siteId))
    .orderBy(desc(agentGoals.createdAt))
    .limit(100);
  return c.json({ data: rows });
});

agentRouter.post('/goals', async (c) => {
  const parsed = createGoalSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  const db = c.get('db');
  const siteId = c.get('siteId');
  const auth = c.get('auth');
  const queue = c.get('runtime').queue;

  // A frozen site rejects new goal/run creation; reads stay available (Req 14.4).
  {
    const { KillSwitchService } = await import('../services/kill-switch-service');
    if (await new KillSwitchService({ db, siteId }).isSiteFrozen()) {
      return c.json(
        { errors: [{ code: 'FROZEN', message: 'Agent runtime is frozen for this site; lift the kill switch to create goals.' }] },
        423,
      );
    }
  }

  if (parsed.data.execution === 'async') {
    if (!parsed.data.task) {
      return c.json(
        { errors: [{ code: 'VALIDATION', message: 'task.skillName is required for async execution' }] },
        400,
      );
    }
    // No queue adapter → explicit error; sync execution remains available (Req 3.3).
    if (!queue) {
      return c.json(
        {
          errors: [
            {
              code: 'ASYNC_UNAVAILABLE',
              message: 'Async execution requires a queue adapter; this runtime has none. Use execution: "sync".',
            },
          ],
        },
        400,
      );
    }
  }

  const [goal] = await db.insert(agentGoals).values({
    siteId,
    createdBy: auth.userId ?? null,
    title: parsed.data.title,
    description: parsed.data.description ?? null,
    source: parsed.data.source,
    assigneeAgent: parsed.data.assigneeAgent,
    priority: parsed.data.priority,
    successCriteria: parsed.data.successCriteria,
  }).returning();

  if (parsed.data.execution === 'async') {
    const runService = new AgentRunService(db, siteId, queue);
    const run = await runService.ensureRun({
      goalId: goal!.id,
      agentName: parsed.data.assigneeAgent,
      title: parsed.data.title,
      contextMessage: parsed.data.description,
      createdBy: auth.userId ?? null,
      budget: parsed.data.budget,
      status: 'queued',
    });
    const payload: AgentRunJobPayload = {
      siteId,
      goalId: goal!.id,
      runId: run.runId,
      skillName: parsed.data.task!.skillName,
      arguments: parsed.data.task!.arguments,
      capabilities: auth.roles ?? [],
      userId: auth.userId ?? null,
      contextMessage: parsed.data.description,
    };
    await queue!.enqueue(AGENT_RUNS_QUEUE, 'execute', payload);
    return c.json({ data: { goal, runId: run.runId, status: 'queued' } }, 202);
  }

  return c.json({ data: goal }, 201);
});

// ── Agent roles + planner delegation (content-os task 10; Req 10.1-10.5) ───

function canManageRoles(c: Context<AppEnv>): boolean {
  const roles = c.get('auth').roles ?? [];
  return roles.includes('admin') || roles.includes('*');
}

const roleBodySchema = z.object({
  name: z.string().min(1).max(80).regex(/^[a-z][a-z0-9_-]*$/),
  description: z.string().max(500).optional(),
  systemPromptRef: z.string().max(200).optional(),
  model: z.string().max(120).optional(),
  capabilities: z.array(z.string().min(1).max(80)).max(32),
  enabled: z.boolean().optional(),
});

agentRouter.get('/roles', async (c) => {
  const { AgentRoleService } = await import('../services/agent-role-service');
  const service = new AgentRoleService({ db: c.get('db'), siteId: c.get('siteId') });
  return c.json({ data: await service.list() });
});

agentRouter.post('/roles', async (c) => {
  if (!canManageRoles(c)) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Managing agent roles requires an admin.' }] }, 403);
  }
  const parsed = roleBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  const { AgentRoleService, AgentRoleError } = await import('../services/agent-role-service');
  const service = new AgentRoleService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    return c.json({ data: await service.create(parsed.data) }, 201);
  } catch (err) {
    if (err instanceof AgentRoleError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

agentRouter.patch('/roles/:name', async (c) => {
  if (!canManageRoles(c)) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Managing agent roles requires an admin.' }] }, 403);
  }
  const parsed = roleBodySchema.partial().omit({ name: true }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  const { AgentRoleService, AgentRoleError } = await import('../services/agent-role-service');
  const service = new AgentRoleService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    return c.json({ data: await service.update(c.req.param('name'), parsed.data) });
  } catch (err) {
    if (err instanceof AgentRoleError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

agentRouter.delete('/roles/:name', async (c) => {
  if (!canManageRoles(c)) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Managing agent roles requires an admin.' }] }, 403);
  }
  const { AgentRoleService, AgentRoleError } = await import('../services/agent-role-service');
  const service = new AgentRoleService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    await service.delete(c.req.param('name'));
    return c.json({ data: null });
  } catch (err) {
    if (err instanceof AgentRoleError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

const decomposeSchema = z.object({
  subGoals: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        agentRole: z.string().min(1).max(80),
        acceptance: z.record(z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(20),
});

/** Planner: decompose a goal into role-scoped sub-goals (Req 10.1/10.3). */
agentRouter.post('/goals/:id/decompose', async (c) => {
  const roles = c.get('auth').roles ?? [];
  if (!(roles.includes('admin') || roles.includes('goals:write') || roles.includes('*'))) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Capability "goals:write" is required.' }] }, 403);
  }
  const parsed = decomposeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  const { PlannerService, PlannerError } = await import('../services/planner-service');
  const planner = new PlannerService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    return c.json({ data: await planner.decompose(c.req.param('id'), parsed.data.subGoals) }, 201);
  } catch (err) {
    if (err instanceof PlannerError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

/** Settles a parent goal from its children's terminal states (Req 10.5). */
agentRouter.post('/goals/:id/settle', async (c) => {
  const { PlannerService, PlannerError } = await import('../services/planner-service');
  const planner = new PlannerService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    return c.json({ data: await planner.settleParent(c.req.param('id')) });
  } catch (err) {
    if (err instanceof PlannerError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

// ── Trust ledger (content-os task 13; Req 12.5) ─────────────────────────────

/** Grants + open incidents — the trust ledger view. */
agentRouter.get('/autonomy', async (c) => {
  const { AutonomyService } = await import('../services/autonomy-service');
  const autonomy = new AutonomyService({ db: c.get('db'), siteId: c.get('siteId') });
  return c.json({
    data: {
      grants: await autonomy.listGrants(),
      openIncidents: await autonomy.listIncidents({ openOnly: true }),
    },
  });
});

agentRouter.get('/autonomy/promotions', async (c) => {
  const { TrustLedgerService } = await import('../services/trust-ledger-service');
  const ledger = new TrustLedgerService({ db: c.get('db'), siteId: c.get('siteId') });
  return c.json({ data: await ledger.listPendingProposals() });
});

const promotionCheckSchema = z.object({
  agentRole: z.string().min(1).max(120),
  capability: z.string().min(1).max(120),
});

/** Evaluates evidence and creates a proposal when eligible — never applies. */
agentRouter.post('/autonomy/promotions/check', async (c) => {
  const parsed = promotionCheckSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  const { TrustLedgerService } = await import('../services/trust-ledger-service');
  const ledger = new TrustLedgerService({ db: c.get('db'), siteId: c.get('siteId') });
  const data = await ledger.proposePromotion(parsed.data.agentRole, parsed.data.capability);
  return c.json({ data }, data.proposed ? 201 : 200);
});

const promotionDecideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().max(500).optional(),
});

/** Human decision on a promotion proposal — the only path to a higher level. */
agentRouter.post('/autonomy/promotions/:id/decide', async (c) => {
  const roles = c.get('auth').roles ?? [];
  if (!(roles.includes('admin') || roles.includes('agents:freeze') || roles.includes('*'))) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Promotion decisions require an admin.' }] },
      403,
    );
  }
  const parsed = promotionDecideSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  const { TrustLedgerService, TrustLedgerError } = await import('../services/trust-ledger-service');
  const ledger = new TrustLedgerService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    const data = await ledger.decidePromotion(
      c.req.param('id'),
      parsed.data.decision,
      c.get('auth').userId ?? null,
      parsed.data.reason,
    );
    return c.json({ data });
  } catch (err) {
    if (err instanceof TrustLedgerError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

// ── Constitution (content-os task 16; Req 15.1-15.6) ────────────────────────

function canEditConstitution(c: Context<AppEnv>): boolean {
  const roles = c.get('auth').roles ?? [];
  return roles.includes('admin') || roles.includes('constitution:write') || roles.includes('*');
}

/** All versions plus the active one — the editor's version list. */
agentRouter.get('/constitution', async (c) => {
  const { ConstitutionService } = await import('../services/constitution-service');
  const service = new ConstitutionService({ db: c.get('db'), siteId: c.get('siteId') });
  return c.json({ data: { versions: await service.listVersions(), active: (await service.getActive()) ?? null } });
});

agentRouter.post('/constitution', async (c) => {
  if (!canEditConstitution(c)) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Editing the constitution requires an admin.' }] }, 403);
  }
  const body = (await c.req.json().catch(() => null)) as { evaluators?: unknown } | null;
  const { ConstitutionService, ConstitutionError } = await import('../services/constitution-service');
  const service = new ConstitutionService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    return c.json({ data: await service.createDraft(body?.evaluators, c.get('auth').userId ?? null) }, 201);
  } catch (err) {
    if (err instanceof ConstitutionError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

const dryRunSchema = z.object({ samples: z.array(z.record(z.unknown())).min(1).max(20) });

/** Evaluates a version against real content samples without activating (Req 15.5). */
agentRouter.post('/constitution/:id/dry-run', async (c) => {
  const parsed = dryRunSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  const { ConstitutionService, ConstitutionError } = await import('../services/constitution-service');
  const { createConfiguredLLMProvider } = await import('../services/llm-provider');
  const service = new ConstitutionService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    llm: createConfiguredLLMProvider(c.env as unknown as Record<string, string | undefined>),
  });
  try {
    return c.json({ data: await service.dryRun(c.req.param('id'), parsed.data.samples) });
  } catch (err) {
    if (err instanceof ConstitutionError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

agentRouter.post('/constitution/:id/activate', async (c) => {
  if (!canEditConstitution(c)) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Activating a constitution requires an admin.' }] }, 403);
  }
  const { ConstitutionService, ConstitutionError } = await import('../services/constitution-service');
  const service = new ConstitutionService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    return c.json({ data: await service.activate(c.req.param('id'), c.get('auth').userId ?? null) });
  } catch (err) {
    if (err instanceof ConstitutionError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

// ── Kill switch (content-os task 15; Req 14.1-14.5) ─────────────────────────

const killSwitchSchema = z.object({
  scope: z.enum(['run', 'intent', 'role', 'site']),
  targetId: z.string().min(1).optional(),
  reason: z.string().max(500).optional(),
});

function canFreeze(c: Context<AppEnv>): boolean {
  const roles = c.get('auth').roles ?? [];
  return roles.includes('admin') || roles.includes('agents:freeze') || roles.includes('*');
}

function canOperateAgents(c: Context<AppEnv>): boolean {
  const roles = c.get('auth').roles ?? [];
  return roles.includes('admin') || roles.includes('agents:freeze') || roles.includes('*');
}

/** Active freezes + recent freeze/lift history. */
agentRouter.get('/kill-switch', async (c) => {
  const { KillSwitchService } = await import('../services/kill-switch-service');
  const service = new KillSwitchService({ db: c.get('db'), siteId: c.get('siteId') });
  return c.json({ data: { active: await service.listActive(), history: await service.listHistory(50) } });
});

agentRouter.post('/kill-switch', async (c) => {
  const parsed = killSwitchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  // Freezing a role/site requires the dedicated capability (Req 14.3);
  // run/intent scopes accept the same operators.
  const allowed = parsed.data.scope === 'role' || parsed.data.scope === 'site' ? canFreeze(c) : canOperateAgents(c);
  if (!allowed) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Capability "agents:freeze" is required.' }] },
      403,
    );
  }
  const { KillSwitchService, KillSwitchError } = await import('../services/kill-switch-service');
  const service = new KillSwitchService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    const data = await service.activate(parsed.data, c.get('auth').userId ?? null);
    return c.json({ data });
  } catch (err) {
    if (err instanceof KillSwitchError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

agentRouter.post('/kill-switch/lift', async (c) => {
  const parsed = z
    .object({ scope: z.enum(['role', 'site']), targetId: z.string().min(1).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  if (!canFreeze(c)) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Capability "agents:freeze" is required.' }] },
      403,
    );
  }
  const { KillSwitchService, KillSwitchError } = await import('../services/kill-switch-service');
  const service = new KillSwitchService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    const data = await service.lift(parsed.data.scope, {
      targetRole: parsed.data.targetId,
      actor: c.get('auth').userId ?? null,
    });
    return c.json({ data });
  } catch (err) {
    if (err instanceof KillSwitchError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

// ── Veto window (content-os task 14; Req 13.2/13.4/13.6) ────────────────────

function canVeto(c: Context<AppEnv>): boolean {
  const roles = c.get('auth').roles ?? [];
  return roles.includes('admin') || roles.includes('veto') || roles.includes('*');
}

/** Stagings inside their veto window, soonest deadline first. */
agentRouter.get('/staged', async (c) => {
  const { VetoService } = await import('../services/veto-service');
  const service = new VetoService({ db: c.get('db'), siteId: c.get('siteId') });
  return c.json({ data: await service.listPending() });
});

agentRouter.post('/staged/:id/veto', async (c) => {
  if (!canVeto(c)) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Veto requires the admin or veto role.' }] },
      403,
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const { VetoService, VetoServiceError } = await import('../services/veto-service');
  const service = new VetoService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    const data = await service.veto(c.req.param('id'), c.get('auth').userId ?? null, body.reason);
    return c.json({ data });
  } catch (err) {
    if (err instanceof VetoServiceError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

agentRouter.post('/runs/:id/cancel', async (c) => {
  const service = new AgentRunService(c.get('db'), c.get('siteId'), c.get('runtime').queue);
  const cancelled = await service.cancelRun(c.req.param('id'));
  if (!cancelled) {
    return c.json(
      { errors: [{ code: 'NOT_CANCELLABLE', message: 'Run not found or already in a terminal state' }] },
      409,
    );
  }
  return c.json({ data: cancelled });
});

agentRouter.get('/runs', async (c) => {
  const service = new AgentRunService(c.get('db'), c.get('siteId'), c.get('runtime').queue);
  return c.json({ data: await service.listRuns() });
});

agentRouter.post('/runs/:id/retry', async (c) => {
  const service = new AgentRunService(c.get('db'), c.get('siteId'), c.get('runtime').queue);
  const retry = await service.retryRun(c.req.param('id'));
  if (!retry) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Run not found' }] }, 404);
  }
  return c.json({ data: retry }, 201);
});

agentRouter.get('/tools', async (c) => {
  const service = new ToolRegistryService(c.get('db'), c.get('siteId'), CORE_SKILLS);
  const tools = await service.listTools();
  return c.json({
    data: tools.map(({ handler: _handler, ...tool }) => tool),
  });
});

agentRouter.get('/approvals', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const rows = await db
    .select()
    .from(agentApprovals)
    .where(eq(agentApprovals.siteId, siteId))
    .orderBy(desc(agentApprovals.createdAt))
    .limit(100);
  return c.json({ data: rows });
});

const agentDecideSchema = z.object({
  reviewerRunId: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(1000).optional(),
});

/**
 * Agent-as-reviewer decision (content-os task 11; Req 11.2-11.4). Approvals
 * finalize only on confident approve; rejections/low confidence escalate to
 * a human with a deep-link and the approval stays pending.
 */
agentRouter.post('/approvals/:id/agent-decide', async (c) => {
  const parsed = agentDecideSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  const { ReviewerService, ReviewerError } = await import('../services/reviewer-service');
  const service = new ReviewerService({ db: c.get('db'), siteId: c.get('siteId') });
  try {
    const data = await service.decide({
      approvalId: c.req.param('id'),
      reviewerRunId: parsed.data.reviewerRunId,
      decision: parsed.data.decision,
      confidence: parsed.data.confidence,
      reason: parsed.data.reason,
      capabilities: c.get('auth').roles ?? [],
    });
    return c.json({ data });
  } catch (err) {
    if (err instanceof ReviewerError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});

agentRouter.post('/approvals/:id/decide', async (c) => {
  const body = z.object({
    decision: z.enum(['approved', 'rejected']),
    reason: z.string().max(1000).optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) {
    return validationError(c, body.error);
  }

  const db = c.get('db');
  const siteId = c.get('siteId');
  const auth = c.get('auth');
  const [existing] = await db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.id, c.req.param('id')), eq(agentApprovals.siteId, siteId)))
    .limit(1);

  if (!existing) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Approval not found' }] }, 404);
  }
  if (existing.status !== 'pending') {
    return c.json({ errors: [{ code: 'CONFLICT', message: 'Approval already processed' }] }, 409);
  }
  if (existing.expiresAt && existing.expiresAt <= new Date()) {
    return c.json({ errors: [{ code: 'EXPIRED', message: 'Approval expired' }] }, 409);
  }

  const [record] = await db
    .update(agentApprovals)
    .set({
      status: body.data.decision,
      decidedAt: new Date(),
      decidedBy: auth.userId ?? null,
      decisionReason: body.data.reason ?? null,
    })
    .where(and(eq(agentApprovals.id, c.req.param('id')), eq(agentApprovals.siteId, siteId)))
    .returning();

  if (!record) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Approval not found' }] }, 404);
  }
  agentApprovalsTotal.inc({ subject_type: record.subjectType, status: record.status });
  agentApprovalLatency.observe(
    { subject_type: record.subjectType, status: record.status },
    (Date.now() - record.createdAt.getTime()) / 1000,
  );
  return c.json({ data: record });
});

agentRouter.get('/artifacts', async (c) => {
  const service = new AgentArtifactService(c.get('db'), c.get('siteId'));
  return c.json({ data: await service.listArtifacts(c.req.query('runId')) });
});

agentRouter.post('/artifacts', async (c) => {
  const parsed = artifactSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  const service = new AgentArtifactService(c.get('db'), c.get('siteId'));
  return c.json({ data: await service.createArtifact(parsed.data) }, 201);
});

agentRouter.post('/artifacts/:id/evaluate', async (c) => {
  const runId = c.req.query('runId');
  if (!runId) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'runId query is required' }] }, 400);
  }
  const service = new AgentEvaluationService(c.get('db'), c.get('siteId'));
  return c.json({ data: await service.evaluateArtifact({ runId, artifactId: c.req.param('id') }) });
});

agentRouter.post('/artifacts/:id/publish', async (c) => {
  const body = z.object({ overrideReason: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    return validationError(c, body.error);
  }
  const service = new AgentArtifactService(c.get('db'), c.get('siteId'));
  const result = await service.publishArtifact(c.req.param('id'), body.data.overrideReason);
  if (!result.allowed) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: result.message }] }, 403);
  }
  return c.json({ data: result.artifact });
});

agentRouter.post('/artifacts/:id/rollback', async (c) => {
  const body = z.object({ reason: z.string().optional() }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) {
    return validationError(c, body.error);
  }
  const service = new AgentArtifactService(c.get('db'), c.get('siteId'));
  const result = await service.rollbackArtifact(c.req.param('id'), body.data.reason);
  if (!result.allowed) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: result.message }] }, 403);
  }
  return c.json({ data: result.artifact });
});

agentRouter.get('/memory', async (c) => {
  const service = new AgentMemoryService(c.get('db'), c.get('siteId'));
  return c.json({ data: await service.buildContext({ scope: c.req.query('scope'), scopeId: c.req.query('scopeId') }) });
});

agentRouter.post('/memory', async (c) => {
  const parsed = memorySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }
  const service = new AgentMemoryService(c.get('db'), c.get('siteId'));
  return c.json({ data: await service.writeMemory(parsed.data) }, 201);
});

agentRouter.post('/generate-app', async (c) => {
  const parsed = generateAppSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return validationError(c, parsed.error);
  }

  const db = c.get('db');
  const siteId = c.get('siteId');
  const auth = c.get('auth');
  const runService = new AgentRunService(db, siteId, c.get('runtime').queue);
  const artifactService = new AgentArtifactService(db, siteId);
  const evaluationService = new AgentEvaluationService(db, siteId);

  const run = await runService.ensureRun({
    agentName: 'lumibase-app-generator',
    title: `Generate ${parsed.data.targetApp}`,
    contextMessage: `Generate app from ${parsed.data.collections.join(', ')}`,
    createdBy: auth.userId ?? null,
    budget: parsed.data.budget,
  });

  const pageArtifact = await artifactService.createArtifact({
    runId: run.runId,
    type: 'page_spec',
    title: `${parsed.data.targetApp} pages`,
    content: {
      targetApp: parsed.data.targetApp,
      collections: parsed.data.collections,
      constraints: parsed.data.constraints,
      pages: parsed.data.collections.map((collection) => ({ collection, route: `/${collection}` })),
    },
    metadata: { approvalPolicy: parsed.data.approvalPolicy },
  });
  const componentArtifact = await artifactService.createArtifact({
    runId: run.runId,
    type: 'component_spec',
    title: `${parsed.data.targetApp} components`,
    content: {
      targetApp: parsed.data.targetApp,
      components: parsed.data.collections.map((collection) => ({ name: `${collection}List`, collection })),
    },
    metadata: { approvalPolicy: parsed.data.approvalPolicy },
  });
  const seedArtifact = await artifactService.createArtifact({
    runId: run.runId,
    type: 'seed_data',
    title: `${parsed.data.targetApp} seed data`,
    content: {
      collections: Object.fromEntries(
        parsed.data.collections.map((collection) => [
          collection,
          [{ id: `${collection}_sample`, status: 'draft' }],
        ]),
      ),
    },
    metadata: { approvalPolicy: parsed.data.approvalPolicy },
  });
  const apiArtifact = await artifactService.createArtifact({
    runId: run.runId,
    type: 'api_spec',
    title: `${parsed.data.targetApp} API spec`,
    content: {
      openapi: '3.1.0',
      info: { title: `${parsed.data.targetApp} generated API`, version: '0.1.0' },
      paths: Object.fromEntries(
        parsed.data.collections.map((collection) => [`/${collection}`, { get: { summary: `List ${collection}` } }]),
      ),
    },
    metadata: { approvalPolicy: parsed.data.approvalPolicy },
  });

  const evaluations = await Promise.all([
    evaluationService.evaluateArtifact({ runId: run.runId, artifactId: pageArtifact.id }),
    evaluationService.evaluateArtifact({ runId: run.runId, artifactId: componentArtifact.id }),
    evaluationService.evaluateArtifact({ runId: run.runId, artifactId: seedArtifact.id }),
    evaluationService.evaluateArtifact({ runId: run.runId, artifactId: apiArtifact.id }),
  ]);
  await runService.closeRun(run.runId, { artifacts: 4, evaluations: evaluations.length });

  return c.json({ data: { run, artifacts: [pageArtifact, componentArtifact, seedArtifact, apiArtifact], evaluations } }, 201);
});

function validationError(c: Context<AppEnv>, error: z.ZodError) {
  return c.json(
    {
      errors: error.issues.map((issue) => ({
        code: 'VALIDATION',
        message: issue.message,
        path: issue.path.map(String),
      })),
    },
    400,
  );
}
