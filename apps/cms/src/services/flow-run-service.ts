import { flows, flowRuns, type Database } from '@lumibase/database';
import type { KeyProvider, QueueProvider } from '@lumibase/runtime';
import { formatSafeError } from '@lumibase/contracts/utils';
import { and, eq } from 'drizzle-orm';
import { runFlow, type FlowGraph, type FlowRunResult } from './flow-service';

/**
 * Manual flow runs + AI chat async (high-load-cache-readiness §10.3).
 *
 * `POST /flows/:id/run` inserts a `pending` row and enqueues when a queue is
 * available; otherwise executes inline with `LUMIBASE_FLOW_SYNC_TIMEOUT`.
 * AI chat `Prefer: respond-async` reuses `lumibase_flow_runs` with
 * `run_type = ai_chat` (design §21.5 CHỐT).
 */

export const FLOW_RUNS_QUEUE = 'flow-runs';

export type FlowRunKind = 'flow' | 'ai_chat';

export interface FlowManualRunJob {
  kind: 'flow';
  siteId: string;
  runId: string;
  flowId: string;
  input: Record<string, unknown>;
}

export interface AiChatRunJob {
  kind: 'ai_chat';
  siteId: string;
  runId: string;
  conversationId: string;
  message: string;
  userCapabilities: string[];
  userId: string | null;
}

export type FlowRunJob = FlowManualRunJob | AiChatRunJob;

export function flowSyncTimeoutMs(env?: Record<string, string | undefined>): number {
  const raw = env?.LUMIBASE_FLOW_SYNC_TIMEOUT ?? process.env.LUMIBASE_FLOW_SYNC_TIMEOUT ?? '30000';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

export async function createPendingRun(
  db: Database,
  values: {
    siteId: string;
    flowId?: string | null;
    runType?: FlowRunKind;
    input: Record<string, unknown>;
  },
) {
  const [run] = await db
    .insert(flowRuns)
    .values({
      siteId: values.siteId,
      flowId: values.flowId ?? null,
      runType: values.runType ?? 'flow',
      status: 'pending',
      input: values.input,
    })
    .returning();
  return run!;
}

export async function markRunRunning(db: Database, runId: string, siteId: string): Promise<void> {
  await db
    .update(flowRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(flowRuns.id, runId), eq(flowRuns.siteId, siteId)));
}

export async function persistRunOutcome(
  db: Database,
  runId: string,
  siteId: string,
  result: FlowRunResult & { output?: Record<string, unknown> },
): Promise<void> {
  await db
    .update(flowRuns)
    .set({
      status: result.status,
      steps: result.steps,
      output: result.output ?? result.steps['previous'] ?? {},
      error: result.error ?? null,
      finishedAt: new Date(),
    })
    .where(and(eq(flowRuns.id, runId), eq(flowRuns.siteId, siteId)));
}

export async function persistAiChatOutcome(
  db: Database,
  runId: string,
  siteId: string,
  output: Record<string, unknown>,
  status: 'success' | 'error',
  error?: string | null,
): Promise<void> {
  await db
    .update(flowRuns)
    .set({
      status,
      output,
      error: error ?? null,
      finishedAt: new Date(),
    })
    .where(and(eq(flowRuns.id, runId), eq(flowRuns.siteId, siteId)));
}

export async function executeFlowGraph(
  db: Database,
  siteId: string,
  flowId: string,
  input: Record<string, unknown>,
  keys: KeyProvider | undefined,
  runId: string,
  signal?: AbortSignal,
): Promise<FlowRunResult> {
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, flowId), eq(flows.siteId, siteId)));
  if (!flow) {
    return { status: 'error', steps: {}, error: 'Flow not found' };
  }
  return runFlow(flow.graph as FlowGraph, input, {
    db,
    siteId,
    keys,
    runId,
    _signal: signal,
  });
}

export async function runFlowSyncWithTimeout(
  db: Database,
  siteId: string,
  flowId: string,
  runId: string,
  input: Record<string, unknown>,
  keys: KeyProvider | undefined,
  env?: Record<string, string | undefined>,
): Promise<FlowRunResult> {
  const timeoutMs = flowSyncTimeoutMs(env);
  const signal = AbortSignal.timeout(timeoutMs);
  await markRunRunning(db, runId, siteId);
  try {
    const result = await executeFlowGraph(db, siteId, flowId, input, keys, runId, signal);
    await persistRunOutcome(db, runId, siteId, result);
    return result;
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'TimeoutError'
        ? `Flow exceeded sync timeout (${timeoutMs}ms). Enable a worker queue for long runs.`
        : err instanceof Error
          ? err.message
          : String(err);
    const failed: FlowRunResult = { status: 'error', steps: {}, error: message };
    await persistRunOutcome(db, runId, siteId, failed);
    return failed;
  }
}

export async function processFlowRunJob(
  db: Database,
  job: FlowRunJob,
  keys?: KeyProvider,
  env?: Record<string, string | undefined>,
): Promise<void> {
  if (job.kind === 'ai_chat') {
    const { executeAiChatRun } = await import('./ai-chat-run-worker');
    await executeAiChatRun(db, job, keys, env);
    return;
  }

  await markRunRunning(db, job.runId, job.siteId);
  const timeoutMs = flowSyncTimeoutMs(env);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const result = await executeFlowGraph(
      db,
      job.siteId,
      job.flowId,
      job.input,
      keys,
      job.runId,
      signal,
    );
    await persistRunOutcome(db, job.runId, job.siteId, result);
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'TimeoutError'
        ? `Flow exceeded worker timeout (${timeoutMs}ms).`
        : err instanceof Error
          ? err.message
          : String(err);
    await persistRunOutcome(db, job.runId, job.siteId, {
      status: 'error',
      steps: {},
      error: message,
    });
  }
}

export interface FlowRunsWorkerDeps {
  db: Database;
  queue?: QueueProvider;
  keys?: KeyProvider;
  env?: Record<string, string | undefined>;
}

export function registerFlowRunsWorker(deps: FlowRunsWorkerDeps): void {
  const { db, queue, keys, env } = deps;
  if (!queue) return;

  queue.process<FlowRunJob>(FLOW_RUNS_QUEUE, async (job) => {
    try {
      if (job.name === 'flow:run' || job.name === 'ai:chat') {
        await processFlowRunJob(db, job.data, keys, env);
      }
    } catch (err) {
      console.error('[flow-runs] job failed', { job: job.name, err: formatSafeError(err) });
      throw err;
    }
  });
}
