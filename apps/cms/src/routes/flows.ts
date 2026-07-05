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
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { z } from 'zod';
import { type FlowGraph as CanonicalGraph, validateGraph } from '@lumibase/shared';
import type { AppEnv } from '../env';
import { listOperations, runFlow, type FlowGraph } from '../services/flow-service';

export const flowsRouter = new Hono<AppEnv>();

/**
 * The webhook trigger authenticates with the flow's own token (constant-time
 * compare) rather than a Studio admin session, so it is exempt from the admin
 * guard. Everything else on this router requires an admin role.
 */
const isWebhookTrigger = (c: { req: { path: string; method: string } }): boolean =>
  c.req.method === 'POST' && /\/[^/]+\/trigger$/.test(c.req.path);

const requireFlowAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (isWebhookTrigger(c)) {
    await next();
    return;
  }
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

flowsRouter.use('*', requireFlowAdmin);

/** Constant-time string comparison to avoid leaking the token via timing. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Known operation keys for graph validation. */
const knownOperationKeys = (): string[] => listOperations().map((o) => o.key);

/** Run validateGraph over a flow's graph; returns an error response or null. */
function validateFlowGraph(c: Context<AppEnv>, graph: unknown) {
  const g = (graph ?? { nodes: [] }) as CanonicalGraph;
  const result = validateGraph(g, knownOperationKeys());
  if (!result.ok) {
    return c.json(
      { errors: result.errors.map((e) => ({ code: e.code, message: e.message, nodeId: e.nodeId })) },
      400,
    );
  }
  return null;
}

// ── GET /operations — registry for the editor palette + knownKeys ─────────────

flowsRouter.get('/operations', (c) => {
  return c.json({ data: listOperations() });
});

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
  // Reject a graph that can't run when the flow is being created active.
  if (parsed.data.status === 'active') {
    const invalid = validateFlowGraph(c, parsed.data.graph);
    if (invalid) return invalid;
  }
  const inserted = await db.insert(flows).values({ siteId, ...parsed.data }).returning();
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
  // If the patch would leave the flow active, its graph must be valid. Use the
  // incoming graph when provided, else fall back to the stored one.
  const willBeActive = parsed.data.status
    ? parsed.data.status === 'active'
    : undefined;
  if (willBeActive || parsed.data.graph) {
    const [current] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.siteId, siteId)))
      .limit(1);
    const effectiveStatus = parsed.data.status ?? current?.status;
    const effectiveGraph = parsed.data.graph ?? current?.graph;
    if (effectiveStatus === 'active') {
      const invalid = validateFlowGraph(c, effectiveGraph);
      if (invalid) return invalid;
    }
  }

  const updated = await db
    .update(flows)
    .set({ ...parsed.data, updatedAt: new Date() })
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

// ── GET /:id/runs/:runId — per-run detail (input + per-node steps) ────────────

flowsRouter.get('/:id/runs/:runId', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const { id, runId } = c.req.param();
  const [row] = await db
    .select()
    .from(flowRuns)
    .where(and(eq(flowRuns.id, runId), eq(flowRuns.flowId, id), eq(flowRuns.siteId, siteId)))
    .limit(1);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Run not found' }] }, 404);
  return c.json({ data: row });
});

// ── POST /:id/trigger — webhook trigger (token-authed, constant-time) ─────────

flowsRouter.post('/:id/trigger', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const id = c.req.param('id');
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, id), eq(flows.siteId, siteId)))
    .limit(1);
  if (!flow) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Flow not found' }] }, 404);

  if (flow.triggerType !== 'webhook' || flow.status !== 'active') {
    return c.json(
      { errors: [{ code: 'NOT_TRIGGERABLE', message: 'Flow is not an active webhook flow.' }] },
      409,
    );
  }

  const opts = (flow.triggerOptions ?? {}) as { token?: string };
  const expected = typeof opts.token === 'string' ? opts.token : '';
  const provided =
    c.req.header('x-flow-token') ??
    (c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
  if (!expected || !provided || !timingSafeEqual(provided, expected)) {
    return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Invalid flow token.' }] }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  const input = { body, headers, query };

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
    .set({
      status: result.status,
      steps: result.steps,
      error: result.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(flowRuns.id, run!.id));

  return c.json({ data: { runId: run!.id, status: result.status } });
});
