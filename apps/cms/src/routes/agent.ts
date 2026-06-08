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
  return c.json({ data: goal }, 201);
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
