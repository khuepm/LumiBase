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

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home'];

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });

  return octets.every(Number.isInteger) ? (octets as [number, number, number, number]) : null;
}

function isBlockedIpv4(hostname: string): boolean {
  const ipv4 = parseIpv4(hostname);
  if (!ipv4) return false;

  const [a, b] = ipv4;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    a === 198 && (b === 18 || b === 19)
  );
}

function isBlockedIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized.includes(':')) return false;

  const ipv4Mapped = normalized.match(/(?::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (ipv4Mapped?.[1] && isBlockedIpv4(ipv4Mapped[1])) return true;

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('0:0:0:0:0:0:0:0') ||
    normalized.startsWith('::ffff:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized)
  );
}

function validateHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('http operation requires a valid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('http operation only supports http(s) URLs');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname === 'metadata.google.internal' ||
    (!hostname.includes('.') && !hostname.includes(':')) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    isBlockedIpv4(hostname) ||
    isBlockedIpv6(hostname)
  ) {
    throw new Error('http operation cannot target local or private network addresses');
  }

  return parsed;
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

  const parsedUrl = validateHttpUrl(url);

  const res = await fetch(parsedUrl.toString(), {
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
