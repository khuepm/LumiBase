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

import type { CacheProvider, KeyProvider } from '@lumibase/runtime';
import { validateOutboundUrl } from './ssrf-guard';

export interface FlowNode {
  id: string;
  /** Operation key; resolved against the registry. */
  key: string;
  options?: Record<string, unknown>;
  next?: string | null;
  onError?: string | null;
  /**
   * Explicit branches (J10, #517): branch key → next node id, `null` ends the
   * run. When set, the runner follows the `branch` the operation returned
   * instead of `next`; a returned branch with no entry is a run error.
   */
  branches?: Record<string, string | null>;
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

/**
 * `node` is the node being executed. Most handlers ignore it; a branching
 * operation reads `node.branches` (to know whether an `error` branch is
 * mapped) and `node.id` (for a per-node idempotency key).
 */
export type OperationHandler = (
  ctx: FlowRunContext,
  options: Record<string, unknown>,
  /** Always passed by `runFlow`; optional so direct callers and older handlers keep compiling. */
  node?: FlowNode,
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
  log: { description: 'Log a message', options: { message: 'string' } },
  condition: {
    description: "Compare a context path against a value; the result carries { pass, branch: 'true' | 'false' }",
    options: { path: "string — e.g. 'input.event.action'", operator: "'==' | '!=' | '>' | '<' | 'contains'", value: 'any' },
  },
  transform: { description: 'Merge fixed fields into the previous step output', options: { set: 'object — fields to set' } },
  http: {
    description: 'Call an external HTTP endpoint (SSRF-guarded, 30s timeout)',
    options: { url: 'string', method: 'GET|POST|PATCH|PUT|DELETE', headers: 'object', body: 'object' },
  },
  sleep: { description: 'Pause the flow', options: { ms: 'number — milliseconds (max 60000)' } },
  mail: { description: 'Send an email notification', options: { to: 'string', subject: 'string' } },
  'drift-scan': {
    description: 'Scan one intent for content drift and open reconciler goals',
    options: { intentId: 'string', maxSemanticItems: 'number' },
  },
  'trust-promote-check': { description: 'Check trust score for autonomy promotion' },
  'deploy:trigger': {
    description: 'Trigger a deployment target',
    options: { targetId: 'string — deployment target id', coalesceWindowMs: 'number — reuse a deploy created within this window' },
  },
  'deploy:status': { description: 'Fetch latest deployment status', options: { targetId: 'string — deployment target id' } },
  'ai:decision': {
    description:
      "Governed AI decision on one item with a pinned review profile version; branches 'true' | 'false' | 'unknown' | 'error' (or a choice key). Needs aiDecisions.flows and ai:decide.",
    options: {
      profileKey: 'string — review profile key',
      profileVersion: 'number — pinned profile version (required)',
      collection: 'string — collection of the item',
      itemId: 'string — item id (defaults to input.itemId)',
      questionKey: 'string — profile question that decides the branch',
      noulThreshold: "number 0.5–1 — noul questions: 'true' when ≥ t, 'false' when ≤ 1 − t, else 'unknown'",
      minConfidence: "number 0–1 — choice questions: below it the branch is 'unknown'",
    },
  },
  'ai:apply-tags': {
    description:
      'Propose adding the decided category to a tags field. Shadow by default (records only); live needs aiDecisions.automation with a gate and matching thresholds, and still becomes an approval (L1 cap).',
    options: {
      decisionNode: 'string — step id of the ai:decision node (defaults to the previous step)',
      collection: 'string — collection of the item',
      itemId: 'string — item id (defaults to input.itemId)',
      tagField: 'string — array-of-strings field to add the tag to',
      tagMap: 'object — choice key → tag (unmapped keys use the choice key)',
      locale: 'string — item locale for the threshold (defaults to input.locale)',
    },
  },
  'editorial:route': {
    description:
      'Propose a review queue for the item from a decision. Shadow by default; live needs the automation gate and becomes an approval (L1 cap). Never publishes; the submit_review transition is proposed only.',
    options: {
      decisionNode: 'string — step id of the ai:decision node (defaults to the previous step)',
      collection: 'string — collection of the item',
      itemId: 'string — item id (defaults to input.itemId)',
      queueField: 'string — field that holds the queue name',
      queues: "object — decision branch → queue name",
      manualQueue: "string — queue suggested when the decision is 'unknown' (never live)",
      submitForReview: 'boolean — propose the submit_review transition when the editorial state allows it',
      locale: 'string — item locale for the threshold (defaults to input.locale)',
    },
  },
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

  // `branch` drives a node with explicit branches; `pass` stays for graphs
  // that read it (legacy `next`-only graphs ignore `branch`).
  return { pass, branch: pass ? 'true' : 'false', actual };
});

registerHandler('transform', async (ctx, options) => {
  // Pass-through transform: merges options into a `data` object.
  return { ...(ctx.steps['previous'] ?? {}), ...(options['set'] as Record<string, unknown>) };
});

registerHandler('http', async (ctx, options) => {
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

  const parentSignal = ctx.env['_signal'] as AbortSignal | undefined;
  const timeoutSignal = AbortSignal.timeout(30_000);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(guard.url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  return {
    status: res.status,
    ok: res.ok,
    body: await res.text(),
  };
});

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error('Flow aborted'));
        },
        { once: true },
      );
    }
  });
}

registerHandler('sleep', async (ctx, options) => {
  const ms = Math.min(60_000, Number(options['ms'] ?? 0));
  const signal = ctx.env['_signal'] as AbortSignal | undefined;
  await abortableSleep(ms, signal);
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

  // Semantic rules (J12) need the decision path: cache (quota), keys and the
  // provider config. Manual runs and the Docker/Node event/schedule worker
  // (B121) carry them; a runner without them reports the semantic pass
  // `unavailable` and changes nothing.
  const { semanticDriftRuntimeFromEnv } = await import('./semantic-drift-scan');
  const semantic = semanticDriftRuntimeFromEnv({
    ...deps,
    cache: ctx.env['cache'] as CacheProvider | undefined,
    keys: ctx.env['keys'] as KeyProvider | undefined,
    processEnv: (ctx.env['processEnv'] ?? undefined) as Record<string, string | undefined> | undefined,
  });
  const maxSemanticItems = Number(options['maxSemanticItems']);
  const scan = await new DriftService({ ...deps, semantic }).scanIntent(intentId, {
    timeBudgetMs: Math.min(60_000, Number(options['timeBudgetMs'] ?? 10_000)),
    ...(Number.isFinite(maxSemanticItems) && maxSemanticItems > 0 ? { maxSemanticItems } : {}),
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
    // Req 5.4: bursts of content events within the window collapse into one
    // build instead of one deploy per event.
    coalesceWindowMs: Number(options['coalesceWindowMs'] ?? 0) || undefined,
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

registerHandler('ai:decision', async (ctx, options, node) => {
  // Jev J10 (#517): a governed decision that picks the next branch. The
  // module is lazy-imported like drift-scan so the generic engine does not
  // load the review/decision stack until a flow uses it.
  const { runAiDecisionNode } = await import('./flow-ai-decision');
  return runAiDecisionNode(ctx, options, node);
});

registerHandler('ai:apply-tags', async (ctx, options, node) => {
  // Jev J11 (#518): shadow-first metadata automation, lazy like ai:decision.
  const { runAutomationNode } = await import('./ai-automation-ops');
  return runAutomationNode('tag', ctx, options, node);
});

registerHandler('editorial:route', async (ctx, options, node) => {
  const { runAutomationNode } = await import('./ai-automation-ops');
  return runAutomationNode('route', ctx, options, node);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface FlowRunResult {
  status: 'success' | 'error';
  steps: Record<string, unknown>;
  error?: string;
}

/** The `branch` an operation returned, or null when it returned none. */
function branchOf(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const branch = (output as { branch?: unknown }).branch;
  return typeof branch === 'string' && branch.length > 0 ? branch : null;
}

export async function runFlow(graph: FlowGraph, input: Record<string, unknown>, env: Record<string, unknown> = {}): Promise<FlowRunResult> {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const entry = graph.entry ?? graph.nodes[0]?.id;
  if (!entry) return { status: 'error', steps: {}, error: 'Empty flow graph' };

  const ctx: FlowRunContext = { input, steps: {}, env };
  let cursor: string | null = entry;
  const visited = new Set<string>();
  const signal = env['_signal'] as AbortSignal | undefined;

  while (cursor) {
    // A cancelled or timed-out run starts no further node, so no downstream
    // side effect runs after the caller gave up (J10, #517).
    if (signal?.aborted) {
      return { status: 'error', steps: ctx.steps, error: `Flow cancelled before node ${cursor}` };
    }
    if (visited.has(cursor)) {
      return { status: 'error', steps: ctx.steps, error: `Cycle detected at node ${cursor}` };
    }
    visited.add(cursor);

    const node = nodesById.get(cursor);
    if (!node) return { status: 'error', steps: ctx.steps, error: `Unknown node: ${cursor}` };

    const handler = handlers.get(node.key);
    if (!handler) return { status: 'error', steps: ctx.steps, error: `Unknown operation: ${node.key}` };

    try {
      const output = await handler(ctx, node.options ?? {}, node);
      ctx.steps[node.id] = output;
      ctx.steps['previous'] = output;
      const branches = node.branches;
      if (branches && Object.keys(branches).length > 0) {
        // Explicit branches never fall through to `next`: a missing or
        // unmapped branch ends the run as an error instead of guessing.
        const branch = branchOf(output);
        if (branch === null) {
          return {
            status: 'error',
            steps: ctx.steps,
            error: `Node ${node.id} has branches but operation ${node.key} returned no branch`,
          };
        }
        if (!Object.prototype.hasOwnProperty.call(branches, branch)) {
          return { status: 'error', steps: ctx.steps, error: `Unmapped branch "${branch}" at node ${node.id}` };
        }
        cursor = branches[branch] ?? null;
      } else {
        cursor = node.next ?? null;
      }
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
