/**
 * Flows routes — POST-GA3.
 *
 *   GET    /api/v1/flows           list flows
 *   POST   /api/v1/flows           create flow
 *   GET    /api/v1/flows/:id       get flow detail
 *   PATCH  /api/v1/flows/:id       update flow (graph/status)
 *   DELETE /api/v1/flows/:id       delete flow
 *   POST   /api/v1/flows/:id/run   trigger a manual run
 *   GET    /api/v1/flows/:id/runs  list runs
 */

import { flows, flowRuns } from '@lumibase/database';
import { validateGraph, type FlowGraph as SharedFlowGraph } from '@lumibase/shared';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { listOperations, runFlow, type FlowGraph } from '../services/flow-service';
import { isValidCron, nextCronRun } from '../services/flow-scheduler';

export const flowsRouter = new Hono<AppEnv>();

const requireFlowAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.get('auth');
  const roles = Array.isArray(auth?.roles) ? auth.roles : [];
  if (!roles.includes('admin')) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }] },
      403,
    );
  }

  await next();
});

/** Constant-time token comparison via SHA-256 digests (runtime-agnostic). */
async function tokensMatch(presented: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
}

/**
 * Webhook trigger (visual-flow-builder Req 3). Registered BEFORE the admin
 * guard: external callers authenticate with the per-flow token in
 * `triggerOptions.token` (compared constant-time), not with a CMS session.
 * `withAuth` bypasses this path for the same reason.
 */
flowsRouter.post('/:id/trigger', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const id = c.req.param('id');

  const [flow] = await db.select().from(flows).where(and(eq(flows.id, id), eq(flows.siteId, siteId)));
  if (!flow || flow.triggerType !== 'webhook' || flow.status !== 'active') {
    // One shared 404 so probing cannot distinguish missing vs inactive flows.
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Flow not found' }] }, 404);
  }

  const expected = (flow.triggerOptions as { token?: string } | null)?.token;
  if (!expected) {
    return c.json({ errors: [{ code: 'WEBHOOK_NOT_CONFIGURED', message: 'Flow has no webhook token configured.' }] }, 401);
  }
  const header = c.req.header('authorization') ?? '';
  const presented = c.req.header('x-flow-token') ?? (header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!presented || !(await tokensMatch(presented, expected))) {
    return c.json({ errors: [{ code: 'UNAUTHENTICATED', message: 'Invalid webhook token.' }] }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.header())) {
    const key = k.toLowerCase();
    if (key === 'authorization' || key === 'x-flow-token' || key === 'cookie') continue;
    headers[key] = v;
  }
  const input = { body, headers, query: c.req.query() } as Record<string, unknown>;

  const [run] = await db
    .insert(flowRuns)
    .values({ siteId, flowId: id, status: 'running', input })
    .returning();

  const result = await runFlow(flow.graph as FlowGraph, input, {
    db,
    siteId,
    keys: c.get('runtime').keys,
    runId: run!.id,
  });

  await db
    .update(flowRuns)
    .set({ status: result.status, steps: result.steps, error: result.error ?? null, finishedAt: new Date() })
    .where(eq(flowRuns.id, run!.id));

  return c.json({ data: { runId: run!.id, status: result.status } });
});

flowsRouter.use('*', requireFlowAdmin);

const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'draft']).default('draft'),
  triggerType: z.enum(['webhook', 'event', 'schedule', 'manual']),
  triggerOptions: z.record(z.unknown()).default({}),
  graph: z.object({
    entry: z.string().optional(),
    nodes: z
      .array(
        z.object({
          id: z.string(),
          key: z.string(),
          options: z.record(z.unknown()).optional(),
          next: z.string().nullable().optional(),
          onError: z.string().nullable().optional(),
        }),
      )
      .default([]),
  }),
});

/**
 * Graph gate (visual-flow-builder Req 5.2): an `active` flow must have a
 * structurally valid graph. Drafts may be saved mid-edit with errors so the
 * editor can persist work-in-progress.
 */
function graphErrorsForSave(status: string | undefined, graph: SharedFlowGraph | undefined) {
  if (status !== 'active' || !graph) return null;
  const result = validateGraph(graph, listOperations().map((o) => o.key));
  return result.ok ? null : result.errors;
}

/**
 * Cron gate for schedule-triggered flows (visual-flow-builder Req 2.3): a
 * provided cron must parse, an *active* schedule flow must have one, and
 * `next_run_at` is (re)computed on save so the sweep picks the flow up.
 */
function cronCheckForSave(
  triggerType: string | undefined,
  status: string | undefined,
  triggerOptions: Record<string, unknown> | undefined,
): { error?: { code: string; message: string }; nextRunAt: Date | null } {
  if (triggerType !== 'schedule') return { nextRunAt: null };
  const cron = (triggerOptions as { cron?: unknown } | undefined)?.cron;
  if (cron !== undefined && !isValidCron(cron)) {
    return { error: { code: 'CRON_INVALID', message: 'triggerOptions.cron is not a valid cron expression.' }, nextRunAt: null };
  }
  if (status === 'active') {
    if (!isValidCron(cron)) {
      return { error: { code: 'CRON_REQUIRED', message: 'An active schedule flow requires triggerOptions.cron.' }, nextRunAt: null };
    }
    return { nextRunAt: nextCronRun(cron, new Date()) };
  }
  return { nextRunAt: null };
}

// Registered before `/:id` so "operations" is not captured as a flow id.
flowsRouter.get('/operations', (c) => {
  return c.json({ data: { operations: listOperations() } });
});

flowsRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const rows = await db.select().from(flows).where(eq(flows.siteId, siteId));
  return c.json({ data: rows });
});

flowsRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const parsed = flowSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  const graphErrors = graphErrorsForSave(parsed.data.status, parsed.data.graph as SharedFlowGraph);
  if (graphErrors) {
    return c.json(
      { errors: graphErrors.map((e) => ({ code: `GRAPH_${e.code}`, message: e.message, nodeId: e.nodeId })) },
      400,
    );
  }
  const cron = cronCheckForSave(parsed.data.triggerType, parsed.data.status, parsed.data.triggerOptions);
  if (cron.error) {
    return c.json({ errors: [cron.error] }, 400);
  }
  const inserted = await db
    .insert(flows)
    .values({ siteId, ...parsed.data, nextRunAt: cron.nextRunAt })
    .returning();
  return c.json({ data: inserted[0] }, 201);
});

flowsRouter.get('/:id', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const id = c.req.param('id');
  const [row] = await db.select().from(flows).where(and(eq(flows.id, id), eq(flows.siteId, siteId)));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Flow not found' }] }, 404);
  return c.json({ data: row });
});

flowsRouter.patch('/:id', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const id = c.req.param('id');
  const parsed = flowSchema.partial().safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }
  // Validate the effective post-patch state: a PATCH that activates a flow
  // with a broken stored graph (or ships a broken graph to an active flow)
  // must fail, not just one that sends both fields together.
  const [existing] = await db
    .select({
      status: flows.status,
      graph: flows.graph,
      triggerType: flows.triggerType,
      triggerOptions: flows.triggerOptions,
    })
    .from(flows)
    .where(and(eq(flows.id, id), eq(flows.siteId, siteId)));
  if (!existing) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Flow not found' }] }, 404);
  }
  const effectiveStatus = parsed.data.status ?? existing.status;
  const effectiveGraph = (parsed.data.graph ?? existing.graph) as SharedFlowGraph;
  const graphErrors = graphErrorsForSave(effectiveStatus, effectiveGraph);
  if (graphErrors) {
    return c.json(
      { errors: graphErrors.map((e) => ({ code: `GRAPH_${e.code}`, message: e.message, nodeId: e.nodeId })) },
      400,
    );
  }
  const cron = cronCheckForSave(
    parsed.data.triggerType ?? existing.triggerType,
    effectiveStatus,
    (parsed.data.triggerOptions ?? existing.triggerOptions) as Record<string, unknown>,
  );
  if (cron.error) {
    return c.json({ errors: [cron.error] }, 400);
  }
  const updated = await db
    .update(flows)
    .set({ ...parsed.data, nextRunAt: cron.nextRunAt, updatedAt: new Date() })
    .where(and(eq(flows.id, id), eq(flows.siteId, siteId)))
    .returning();
  if (updated.length === 0)
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Flow not found' }] }, 404);
  return c.json({ data: updated[0] });
});

flowsRouter.delete('/:id', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const id = c.req.param('id');
  await db.delete(flows).where(and(eq(flows.id, id), eq(flows.siteId, siteId)));
  return c.body(null, 204);
});

flowsRouter.post('/:id/run', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const id = c.req.param('id');
  const [flow] = await db.select().from(flows).where(and(eq(flows.id, id), eq(flows.siteId, siteId)));
  if (!flow) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Flow not found' }] }, 404);

  const input = await c.req.json().catch(() => ({}));

  // Insert run row.
  const [run] = await db
    .insert(flowRuns)
    .values({ siteId, flowId: id, status: 'running', input })
    .returning();

  // `db`/`siteId`/`keys`/`runId` in env let runtime-bound operations
  // (drift-scan, deploy:trigger…) execute tenant-scoped with access to the
  // KeyProvider, without widening the operation options surface.
  const result = await runFlow(flow.graph as FlowGraph, input, {
    db,
    siteId,
    keys: c.get('runtime').keys,
    runId: run!.id,
  });

  await db
    .update(flowRuns)
    .set({
      status: result.status,
      steps: result.steps,
      error: result.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(flowRuns.id, run!.id));

  return c.json({ data: { runId: run!.id, ...result } });
});

flowsRouter.get('/:id/runs', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const id = c.req.param('id');
  const rows = await db
    .select()
    .from(flowRuns)
    .where(and(eq(flowRuns.flowId, id), eq(flowRuns.siteId, siteId)))
    .orderBy(desc(flowRuns.startedAt))
    .limit(100);
  return c.json({ data: rows });
});

// Run detail — per-node steps for the run-history panel (visual-flow-builder Req 6.2).
flowsRouter.get('/:id/runs/:runId', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const id = c.req.param('id');
  const runId = c.req.param('runId');
  const [run] = await db
    .select()
    .from(flowRuns)
    .where(and(eq(flowRuns.id, runId), eq(flowRuns.flowId, id), eq(flowRuns.siteId, siteId)));
  if (!run) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Run not found' }] }, 404);
  return c.json({ data: run });
});
