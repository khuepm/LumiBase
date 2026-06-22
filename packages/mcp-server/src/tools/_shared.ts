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
