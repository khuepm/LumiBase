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
import { z } from 'zod';
import type { AppEnv } from '../env';
import { runFlow, type FlowGraph } from '../services/flow-service';

export const flowsRouter = new Hono<AppEnv>();

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

  const result = await runFlow(flow.graph as FlowGraph, input);

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
