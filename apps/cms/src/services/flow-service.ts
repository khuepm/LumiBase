/**
 * Flow service — POST-GA3 Operations engine.
 *
 * Executes a flow graph: a set of operation nodes connected by `next` /
 * `onError` edges. Each operation gets the running context (input, all
 * prior step outputs, environment) and returns its own output.
 *
 * Built-in operation handlers live in this file; external handlers can
 * be registered via `registerHandler()` (used by extensions).
 */

import { validateOutboundUrl } from './ssrf-guard';

export interface FlowNode {
  id: string;
  /** Operation key; resolved against the registry. */
  key: string;
  options?: Record<string, unknown>;
  next?: string | null;
  onError?: string | null;
}

export interface FlowGraph {
  /** Entry node id. Defaults to first node if omitted. */
  entry?: string;
  nodes: FlowNode[];
}

export interface FlowRunContext {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
  env: Record<string, unknown>;
}

export type OperationHandler = (
  ctx: FlowRunContext,
  options: Record<string, unknown>,
) => Promise<unknown>;

const handlers = new Map<string, OperationHandler>();

export function registerHandler(key: string, handler: OperationHandler): void {
  handlers.set(key, handler);
}

export function getHandler(key: string): OperationHandler | undefined {
  return handlers.get(key);
}

/**
 * Palette metadata for built-in operations. Extensions registered at runtime
 * appear in `listOperations()` with just their key; the registry (not this
 * map) stays the source of truth for which keys are runnable.
 */
const OPERATION_DOCS: Record<string, { description: string; options?: Record<string, string> }> = {
  log: { description: 'Log a message', options: { message: 'string — template with {{ }} placeholders' } },
  condition: {
    description: 'Branch on a filter over the payload; non-match routes to onError',
    options: { filter: 'object — { field: { _eq | _neq | _gt | _lt | ... } }' },
  },
  transform: { description: 'Map the payload into a new shape', options: { json: 'object — template with {{ }} placeholders' } },
  http: {
    description: 'Call an external HTTP endpoint',
    options: { url: 'string', method: 'GET|POST|PATCH|PUT|DELETE', headers: 'object', body: 'object' },
  },
  sleep: { description: 'Pause the flow', options: { ms: 'number — milliseconds (bounded)' } },
  mail: { description: 'Send an email notification', options: { to: 'string', subject: 'string', body: 'string' } },
  'drift-scan': { description: 'Run a drift scan over a collection', options: { collection: 'string' } },
  'trust-promote-check': { description: 'Check trust score for autonomy promotion' },
  'deploy:trigger': { description: 'Trigger a deployment target', options: { target: 'string — deployment target id' } },
  'deploy:status': { description: 'Fetch latest deployment status', options: { target: 'string — deployment target id' } },
};

export interface OperationInfo {
  key: string;
  description: string;
  options?: Record<string, string>;
}

/** Registered operations (built-ins + extensions), for the editor palette + validateGraph knownKeys. */
export function listOperations(): OperationInfo[] {
  return [...handlers.keys()].sort().map((key) => ({
    key,
    description: OPERATION_DOCS[key]?.description ?? '',
    ...(OPERATION_DOCS[key]?.options ? { options: OPERATION_DOCS[key]!.options } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Built-in handlers
// ---------------------------------------------------------------------------

registerHandler('log', async (ctx, options) => {
  // eslint-disable-next-line no-console
  console.log('[flow:log]', options['message'] ?? '', { steps: ctx.steps });
  return { logged: true };
});

registerHandler('condition', async (ctx, options) => {
  // Very simple expression: { path: 'steps.x.value', operator: '==', value: 1 }
  const path = String(options['path'] ?? '');
  const expected = options['value'];
  const op = String(options['operator'] ?? '==');

  const actual = path.split('.').reduce<unknown>(
    (acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined),
    ctx as unknown as Record<string, unknown>,
  );

  let pass = false;
  switch (op) {
    case '==': pass = actual === expected; break;
    case '!=': pass = actual !== expected; break;
    case '>':  pass = (actual as number) > (expected as number); break;
    case '<':  pass = (actual as number) < (expected as number); break;
    case 'contains':
      pass = typeof actual === 'string' && actual.includes(String(expected));
      break;
    default:
      pass = false;
  }

  return { pass, actual };
});

registerHandler('transform', async (ctx, options) => {
  // Pass-through transform: merges options into a `data` object.
  return { ...(ctx.steps['previous'] ?? {}), ...(options['set'] as Record<string, unknown>) };
});

registerHandler('http', async (_ctx, options) => {
  const url = String(options['url'] ?? '');
  const method = String(options['method'] ?? 'GET').toUpperCase();
  const headers = (options['headers'] as Record<string, string>) ?? {};
  const body = options['body'];
  if (!url) throw new Error('http operation requires url');

  // Flow URLs are user-supplied; apply the same SSRF policy as the
  // extension sandbox's http:fetch capability.
  const guard = validateOutboundUrl(url);
  if (!guard.allowed || !guard.url) {
    throw new Error(
      `http operation blocked: ${guard.reason ?? 'outbound URL is not allowed'}`,
    );
  }

  const res = await fetch(guard.url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  return {
    status: res.status,
    ok: res.ok,
    body: await res.text(),
  };
});

registerHandler('sleep', async (_ctx, options) => {
  const ms = Math.min(60_000, Number(options['ms'] ?? 0));
  await new Promise((r) => setTimeout(r, ms));
  return { slept: ms };
});

registerHandler('mail', async (_ctx, options) => {
  // Stub — real impl would dispatch via the queue/runtime.
  return { queued: true, to: options['to'], subject: options['subject'] };
});

registerHandler('drift-scan', async (ctx, options) => {
  // Content OS reconciliation cycle (task 6.3; Req 6.1): scan one intent's
  // collection for drift, then turn open drift into reconciler goals.
  // Schedule a flow per intent with the intent's cron in `triggerOptions`.
  // `db`/`siteId` arrive via the run environment (see routes/flows.ts).
  const db = ctx.env['db'];
  const siteId = ctx.env['siteId'];
  const intentId = options['intentId'] ?? ctx.input['intentId'];
  if (!db || typeof siteId !== 'string' || typeof intentId !== 'string') {
    throw new Error('drift-scan requires env.db, env.siteId and an intentId option');
  }

  // Lazy imports keep the generic flow engine decoupled from Content OS.
  const { DriftService } = await import('./drift-service');
  const { ReconcilerService } = await import('./reconciler-service');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps = { db: db as any, siteId };

  const scan = await new DriftService(deps).scanIntent(intentId, {
    timeBudgetMs: Math.min(60_000, Number(options['timeBudgetMs'] ?? 10_000)),
  });
  const reconcile = await new ReconcilerService(deps).reconcileIntent(intentId);
  return { scan, reconcile };
});

registerHandler('trust-promote-check', async (ctx) => {
  // Content OS trust ledger sweep (task 13.1; Req 12.5): evaluates every
  // grant below L4 and creates promotion proposals for eligible candidates.
  // Proposals only become effective through a human decision.
  const db = ctx.env['db'];
  const siteId = ctx.env['siteId'];
  if (!db || typeof siteId !== 'string') {
    throw new Error('trust-promote-check requires env.db and env.siteId');
  }
  const { TrustLedgerService } = await import('./trust-ledger-service');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new TrustLedgerService({ db: db as any, siteId }).sweepPromotions();
});

registerHandler('deploy:trigger', async (ctx, options) => {
  // Deployment integrations (deployment-integrations Req 5.2): auto-deploy on
  // content events. Triggers a deploy for a target via the shared
  // DeploymentService — the same path as the manual API trigger — so it reuses
  // every guard (SSRF, encrypted token, audit). `db`/`siteId`/`keys` arrive via
  // the run environment (see routes/flows.ts); `runId` links the deployment to
  // the flow run for provenance.
  const db = ctx.env['db'];
  const siteId = ctx.env['siteId'];
  const keys = ctx.env['keys'];
  const targetId = String(options['targetId'] ?? ctx.input['targetId'] ?? '');
  if (!db || typeof siteId !== 'string' || !keys) {
    throw new Error('deploy:trigger requires env.db, env.siteId and env.keys');
  }
  if (!targetId) throw new Error('deploy:trigger requires a targetId option');

  const { DeploymentService } = await import('./deployment/deployment-service');
  const service = new DeploymentService({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    siteId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keys: keys as any,
  });
  const row = await service.trigger(targetId, {
    branch: options['branch'] ? String(options['branch']) : undefined,
    reason: options['reason'] ? String(options['reason']) : 'flow auto-deploy',
    source: 'auto',
    triggeredBy: ctx.env['runId'] ? String(ctx.env['runId']) : undefined,
  });
  return { deploymentId: row.id, status: row.status, provider: row.provider };
});

registerHandler('deploy:status', async (ctx, options) => {
  // Refresh and return one deployment's status so a flow can branch on it.
  const db = ctx.env['db'];
  const siteId = ctx.env['siteId'];
  const keys = ctx.env['keys'];
  const deploymentId = String(options['deploymentId'] ?? ctx.input['deploymentId'] ?? '');
  if (!db || typeof siteId !== 'string' || !keys) {
    throw new Error('deploy:status requires env.db, env.siteId and env.keys');
  }
  if (!deploymentId) throw new Error('deploy:status requires a deploymentId option');

  const { DeploymentService } = await import('./deployment/deployment-service');
  const service = new DeploymentService({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    siteId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    keys: keys as any,
  });
  const row = await service.syncDeployment(deploymentId);
  return { deploymentId, status: row?.status ?? 'unknown' };
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface FlowRunResult {
  status: 'success' | 'error';
  steps: Record<string, unknown>;
  error?: string;
}

export async function runFlow(graph: FlowGraph, input: Record<string, unknown>, env: Record<string, unknown> = {}): Promise<FlowRunResult> {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const entry = graph.entry ?? graph.nodes[0]?.id;
  if (!entry) return { status: 'error', steps: {}, error: 'Empty flow graph' };

  const ctx: FlowRunContext = { input, steps: {}, env };
  let cursor: string | null = entry;
  const visited = new Set<string>();

  while (cursor) {
    if (visited.has(cursor)) {
      return { status: 'error', steps: ctx.steps, error: `Cycle detected at node ${cursor}` };
    }
    visited.add(cursor);

    const node = nodesById.get(cursor);
    if (!node) return { status: 'error', steps: ctx.steps, error: `Unknown node: ${cursor}` };

    const handler = handlers.get(node.key);
    if (!handler) return { status: 'error', steps: ctx.steps, error: `Unknown operation: ${node.key}` };

    try {
      const output = await handler(ctx, node.options ?? {});
      ctx.steps[node.id] = output;
      ctx.steps['previous'] = output;
      cursor = node.next ?? null;
    } catch (err) {
      ctx.steps[node.id] = { error: err instanceof Error ? err.message : String(err) };
      cursor = node.onError ?? null;
      if (!cursor) {
        return {
          status: 'error',
          steps: ctx.steps,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  return { status: 'success', steps: ctx.steps };
}
