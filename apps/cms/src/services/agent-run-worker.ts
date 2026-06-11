import type { Database } from '@lumibase/database';
import type { CacheProvider, QueueProvider, SearchProvider } from '@lumibase/runtime';
import { AISecureHarness } from './ai-harness';
import { AgentRunService } from './agent-run-service';
import { ItemService } from './item-service';
import { createConfiguredLLMProvider, type LLMProviderEnv } from './llm-provider';
import { SchemaService } from './schema-service';

/**
 * Async agent run execution (Content OS task 3 / Req 3.2).
 *
 * `POST /api/v1/agent/goals` with `execution: 'async'` creates the goal and
 * a `queued` run, then enqueues this job on the `agent-runs` queue. The
 * worker picks it up outside the request runtime limit and drives the run
 * through the same harness codepath as synchronous execution — capability
 * checks, risk policy, budgets and audit all apply identically.
 */

export const AGENT_RUNS_QUEUE = 'agent-runs';

export interface AgentRunJobPayload {
  siteId: string;
  goalId: string;
  runId: string;
  skillName: string;
  arguments: Record<string, unknown>;
  /** Capabilities captured from the enqueuing session — never widened. */
  capabilities: string[];
  userId?: string | null;
  contextMessage?: string;
}

export interface AgentRunWorkerDeps {
  db: Database;
  cache?: CacheProvider;
  search?: SearchProvider;
  queue?: QueueProvider;
  env: LLMProviderEnv & Record<string, string | undefined>;
}

/**
 * Executes one queued agent run. Cancellation between enqueue and pickup is
 * honoured (the run stays `cancelled`, nothing executes — Req 3.5). The
 * harness itself transitions the run to `awaiting_approval`, `succeeded`,
 * or `failed`.
 */
export async function processAgentRunJob(
  deps: AgentRunWorkerDeps,
  payload: AgentRunJobPayload,
): Promise<void> {
  const runService = new AgentRunService(deps.db, payload.siteId, deps.queue);

  // Skip runs cancelled while queued; markRunning refuses terminal states.
  const started = await runService.markRunning(payload.runId);
  if (!started) {
    return;
  }

  const schemaService = new SchemaService({
    db: deps.db,
    siteId: payload.siteId,
    cache: deps.cache,
  });
  const itemService = new ItemService({
    db: deps.db,
    siteId: payload.siteId,
    userId: payload.userId ?? null,
    cache: deps.cache,
    search: deps.search,
    queue: deps.queue,
  });

  const harness = new AISecureHarness({
    db: deps.db,
    siteId: payload.siteId,
    schemaService,
    itemService,
    llm: createConfiguredLLMProvider(deps.env),
    queue: deps.queue,
  });

  try {
    await harness.execute(
      payload.skillName,
      payload.arguments,
      payload.capabilities,
      payload.contextMessage,
      { goalId: payload.goalId, runId: payload.runId },
    );
  } catch (err) {
    // The harness records expected failures itself; this guards the worker
    // against unexpected throws so the run never sticks in `running`.
    const message = err instanceof Error ? err.message : String(err);
    await runService.failRun(payload.runId, message, { stopReason: 'worker_error' });
  }
}

/**
 * Registers the agent-runs consumer on a long-lived runtime (Docker/Node).
 * Cloudflare Workers wire the same handler through their queue consumer
 * export instead of `process()`.
 */
export function registerAgentRunWorker(deps: AgentRunWorkerDeps): void {
  deps.queue?.process<AgentRunJobPayload>(AGENT_RUNS_QUEUE, async (job) => {
    await processAgentRunJob(deps, job.data);
  });
}
