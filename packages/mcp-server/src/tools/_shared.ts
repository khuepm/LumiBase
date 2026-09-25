import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LumiBaseApiError } from '../client.js';

/** Renders a LumiBase API error (or any thrown value) into a readable string. */
export function formatError(err: unknown): string {
  if (err instanceof LumiBaseApiError) {
    return err.errors.map((e) => `[${e.code}] ${e.message}`).join('; ');
  }
  return String(err);
}

/** Builds a `?a=b&c=d` query string, skipping `undefined` values. */
export function buildQs(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** Wraps a JSON payload as a successful MCP text result. */
export function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Wraps a plain message as a successful MCP text result. */
export function okText(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Wraps a thrown value as an MCP error result. */
export function fail(err: unknown): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${formatError(err)}` }], isError: true };
}

/**
 * Runs a tool handler with uniform error handling. Resolve to the data you want
 * serialized (object), a `CallToolResult` (returned as-is), or a string message.
 */
export async function run(
  fn: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const result = await fn();
    if (result && typeof result === 'object' && 'content' in (result as object)) {
      return result as CallToolResult;
    }
    if (typeof result === 'string') {
      return okText(result);
    }
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/** Standard `confirm` guard shared by every destructive tool. */
export const confirmDescription = 'Must be true to confirm the destructive operation';

/**
 * A governed decision from the CMS: the outcome of a tool call that went through
 * the agent harness rather than straight to a REST handler.
 *
 * Two id spaces, and they are NOT interchangeable:
 *   - `agentApprovalId` — a row in `lumibase_agent_approvals`. This is the id the
 *     Mission Control inbox shows and the one
 *     `POST /api/v1/agent/approvals/:id/decide` accepts.
 *   - `approvalId` — the legacy `lumibase_ai_approvals` row. Kept for
 *     compatibility; `POST /api/v1/ai/approvals/:id/decide` is its endpoint.
 * When both are present, `agentApprovalId` is the one a human should act on.
 */
export interface GovernedDecision {
  status: 'executed' | 'pending_approval' | 'denied';
  /** Machine-readable denial reason, e.g. `VALIDATION`, `AUTONOMY_SHADOW`. */
  code?: string;
  data?: unknown;
  approvalId?: string;
  /** Which table `approvalId` belongs to; the CMS states this explicitly. */
  approvalSpace?: 'agent' | 'legacy_ai';
  agentApprovalId?: string;
  legacyApprovalId?: string;
  runId?: string;
  message?: string;
}

const DECISION_STATUSES = new Set(['executed', 'pending_approval', 'denied']);

/**
 * Recognises a governed decision payload. Deliberately narrow: it requires the
 * `status` discriminant with one of the three known values, so an ordinary REST
 * row that happens to carry a `status` column (items have `draft`/`published`)
 * is not mistaken for one.
 */
export function asGovernedDecision(value: unknown): GovernedDecision | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const status = (value as { status?: unknown }).status;
  if (typeof status !== 'string' || !DECISION_STATUSES.has(status)) return undefined;
  return value as GovernedDecision;
}

/** Renders a governed decision as an MCP tool result. */
export function renderDecision(decision: GovernedDecision, executedText: string): CallToolResult {
  if (decision.status === 'executed') {
    return decision.data === undefined ? okText(executedText) : ok(decision.data);
  }

  if (decision.status === 'pending_approval') {
    // The id and the endpoint are printed on separate lines rather than
    // interpolated into one URL. Two reasons: the reader needs the id verbatim to
    // paste it, and the `path-hardening` source scan (rightly) refuses any
    // template that looks like a request path with a value spliced in.
    const id = decision.agentApprovalId ?? decision.approvalId;
    // Trust `approvalSpace` when the CMS states it; only fall back to inferring
    // from which id is present (older servers did not send the field).
    const space =
      decision.approvalSpace ?? (decision.agentApprovalId ? 'agent' : id ? 'legacy_ai' : undefined);
    const endpoint =
      space === 'agent'
        ? 'POST /api/v1/agent/approvals/{approvalId}/decide'
        : space === 'legacy_ai'
          ? 'POST /api/v1/ai/approvals/{approvalId}/decide'
          : undefined;
    const lines = [
      'Not executed — pending approval.',
      ...(id ? [`Approval id: ${id}`] : []),
      ...(endpoint ? [`Decide at: ${endpoint}`] : []),
      ...(decision.runId ? [`Run: ${decision.runId}`] : []),
      ...(decision.message ? [decision.message] : []),
    ];
    // Not `isError`: awaiting a human is a legitimate outcome, not a failure. The
    // point is that it must not be reported as a completed mutation.
    return okText(lines.join('\n'));
  }

  const reason = decision.code ? `[${decision.code}] ` : '';
  return {
    content: [{ type: 'text', text: `Not executed — denied. ${reason}${decision.message ?? ''}`.trim() }],
    isError: true,
  };
}

/**
 * Reports the outcome of a mutation, using `executedText` ONLY when the response
 * shows the mutation actually happened.
 *
 * Why this exists (#454). Destructive tools used to `await client.delete(...)`
 * and then return a hardcoded sentence, never reading the response. That is safe
 * only as long as the endpoint either throws or has executed — the moment a call
 * can come back "pending approval" (which the governed path does, and which the
 * autonomy gate now makes reachable for plain writes too), the same code reports
 * a deletion that has not happened. Repro S10 injected exactly that.
 *
 * REST endpoints that answer `204` still land on `executedText`, so nothing
 * changes for them.
 */
export function okAfter(response: unknown, executedText: string): CallToolResult {
  const decision = asGovernedDecision(response);
  return decision === undefined ? okText(executedText) : renderDecision(decision, executedText);
}
