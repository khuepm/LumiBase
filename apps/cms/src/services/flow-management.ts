import { z } from 'zod';
import { validateGraph, type FlowGraph as SharedFlowGraph } from '@lumibase/contracts';
import { flows, type Database } from '@lumibase/database';
import { listOperations } from './flow-service';
import { isValidCron, nextCronRun } from './flow-scheduler';

export const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'draft']).default('draft'),
  triggerType: z.enum(['webhook', 'event', 'schedule', 'manual']),
  triggerOptions: z.record(z.string(), z.unknown()).default({}),
  graph: z.object({
    entry: z.string().optional(),
    nodes: z
      .array(
        z.object({
          id: z.string(),
          key: z.string(),
          options: z.record(z.string(), z.unknown()).optional(),
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
export function graphErrorsForSave(status: string | undefined, graph: SharedFlowGraph | undefined) {
  if (status !== 'active' || !graph) return null;
  const result = validateGraph(graph, listOperations().map((o) => o.key));
  return result.ok ? null : result.errors;
}

/**
 * Cron gate for schedule-triggered flows (visual-flow-builder Req 2.3): a
 * provided cron must parse, an *active* schedule flow must have one, and
 * `next_run_at` is (re)computed on save so the sweep picks the flow up.
 */
export function cronCheckForSave(
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

export class FlowSaveError extends Error {
  constructor(readonly errors: Array<{ code: string; message: string; nodeId?: string }>) {
    super(errors.map((error) => `${error.code}: ${error.message}`).join('; '));
  }
}

/** Both REST and governed skills must enter through this write boundary. */
export async function createFlowRecord(db: Database, siteId: string, raw: unknown) {
  const input = flowSchema.parse(raw);
  const graphErrors = graphErrorsForSave(input.status, input.graph as SharedFlowGraph);
  if (graphErrors) throw new FlowSaveError(graphErrors.map((error) => ({ ...error, code: `GRAPH_${error.code}` })));
  const cron = cronCheckForSave(input.triggerType, input.status, input.triggerOptions);
  if (cron.error) throw new FlowSaveError([cron.error]);
  const [row] = await db.insert(flows).values({ siteId, ...input, nextRunAt: cron.nextRunAt }).returning();
  return row;
}
