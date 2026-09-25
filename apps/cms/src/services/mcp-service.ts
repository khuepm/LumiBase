import type { HarnessExecutionResult } from './ai-harness';

/**
 * MCP server adapter (content-os task 4; Req 4.1-4.4).
 *
 * A deliberately thin JSON-RPC 2.0 translation layer over the Agent Harness
 * (design decision 5): the tool list is generated from the `agent_tools`
 * registry and every `tools/call` goes through `AISecureHarness.execute` —
 * the same codepath as the Agent API, so MCP inherits every guard
 * (kill switch, capability, autonomy, pin, load, veto) with zero
 * MCP-specific business logic.
 *
 * Error split (design "Error Handling"): protocol violations are JSON-RPC
 * errors; business outcomes (`denied`, `pending_approval`) are ordinary tool
 * results so MCP clients can surface the approval id to the user (Req 4.4).
 */

/** Protocol revisions this adapter accepts from clients. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;
export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const MCP_SERVER_INFO = { name: 'lumibase-mcp', version: '1.0.0' };

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Tool metadata projected into MCP `tools/list`. */
export interface McpToolSummary {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  enabled?: boolean;
}

/**
 * Port into the existing harness stack. Implemented by the route with
 * `ToolRegistryService` + `AISecureHarness`; mocked directly in tests so the
 * parity property can compare MCP and Agent API decisions byte-for-byte.
 */
export interface McpHarnessPort {
  listTools(): Promise<McpToolSummary[]>;
  execute(
    skillName: string,
    args: Record<string, unknown>,
    capabilities: string[],
    contextMessage?: string,
  ): Promise<HarnessExecutionResult>;
}

/**
 * Decision payload embedded in every `tools/call` result. The shape is the
 * harness result minus internals — identical for MCP and Agent API callers
 * (Property 14).
 */
export interface McpToolDecision {
  status: HarnessExecutionResult['status'];
  /**
   * Machine-readable denial reason, e.g. `VALIDATION`, `AUTONOMY_SHADOW`. Lets a
   * client branch on "fix your arguments" vs "you are not allowed" without
   * parsing prose.
   */
  code?: string;
  data?: unknown;
  /**
   * Id to act on when status is `pending_approval`.
   *
   * ⚠️ Two id spaces exist and they are not interchangeable. `execute()` inserts
   * into BOTH `lumibase_agent_approvals` and the legacy `lumibase_ai_approvals`,
   * and they are decided at two different routes. This field carries the
   * `agent_approvals` id whenever one exists — see `approvalSpace` for which one
   * you actually got, instead of having to guess from the value.
   */
  approvalId?: string;
  /**
   * Which table `approvalId` belongs to, and therefore which endpoint accepts it:
   * - `agent` → `POST /api/v1/agent/approvals/{approvalId}/decide` (`routes/agent.ts`)
   * - `legacy_ai` → `POST /api/v1/ai/approvals/{approvalId}/decide` (`routes/ai.ts`)
   *
   * Added because the previous shape collapsed `agentApprovalId ?? approvalId`
   * into one field, so a client could hold a valid-looking id and call the wrong
   * route with no way to tell.
   */
  approvalSpace?: 'agent' | 'legacy_ai';
  /** The `agent_approvals` id, when the governed path produced one. */
  agentApprovalId?: string;
  /** The legacy `ai_approvals` id, when one was written. */
  legacyApprovalId?: string;
  runId?: string;
  message?: string;
}

export function toToolDecision(result: HarnessExecutionResult): McpToolDecision {
  const decision: McpToolDecision = { status: result.status };
  if (result.code) decision.code = result.code;
  if (result.data !== undefined) decision.data = result.data;

  // `approvalId` keeps its historical meaning (agent id preferred) so existing
  // clients do not change, and the space is now stated rather than inferred.
  const approvalId = result.agentApprovalId ?? result.approvalId;
  if (approvalId) {
    decision.approvalId = approvalId;
    decision.approvalSpace = result.agentApprovalId ? 'agent' : 'legacy_ai';
  }
  if (result.agentApprovalId) decision.agentApprovalId = result.agentApprovalId;
  if (result.approvalId) decision.legacyApprovalId = result.approvalId;

  if (result.runId) decision.runId = result.runId;
  if (result.message) decision.message = result.message;
  return decision;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

export class McpService {
  constructor(private readonly port: McpHarnessPort) {}

  /**
   * Handles one Streamable-HTTP POST body. Returns `null` for notifications
   * (the transport answers 202 Accepted with no body).
   */
  async handle(payload: unknown, capabilities: string[]): Promise<JsonRpcResponse | null> {
    if (payload === undefined) {
      return rpcError(null, PARSE_ERROR, 'Body is not valid JSON');
    }
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      (payload as JsonRpcRequest).jsonrpc !== '2.0' ||
      typeof (payload as JsonRpcRequest).method !== 'string'
    ) {
      return rpcError(null, INVALID_REQUEST, 'Expected a single JSON-RPC 2.0 request object');
    }

    const request = payload as JsonRpcRequest;
    const isNotification = request.id === undefined || request.method.startsWith('notifications/');
    const id = request.id ?? null;

    try {
      const result = await this.dispatch(request, capabilities);
      return isNotification ? null : ok(id, result);
    } catch (err) {
      if (isNotification) return null;
      if (err instanceof McpProtocolError) {
        return rpcError(id, err.code, err.message);
      }
      throw err;
    }
  }

  private async dispatch(request: JsonRpcRequest, capabilities: string[]): Promise<unknown> {
    switch (request.method) {
      case 'initialize': {
        const requested = request.params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
          requested as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
        )
          ? (requested as string)
          : DEFAULT_PROTOCOL_VERSION;
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
        };
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return {};
      case 'tools/list': {
        const tools = await this.port.listTools();
        return {
          tools: tools
            .filter((tool) => tool.enabled !== false)
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema:
                tool.inputSchema && Object.keys(tool.inputSchema).length > 0
                  ? tool.inputSchema
                  : { type: 'object' },
            })),
        };
      }
      case 'tools/call': {
        const name = request.params?.name;
        if (typeof name !== 'string' || name.length === 0) {
          throw new McpProtocolError(INVALID_PARAMS, 'params.name is required');
        }
        const rawArgs = request.params?.arguments ?? {};
        if (rawArgs === null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
          throw new McpProtocolError(INVALID_PARAMS, 'params.arguments must be an object');
        }
        const decision = toToolDecision(
          await this.port.execute(name, rawArgs as Record<string, unknown>, capabilities),
        );
        // Business outcomes ride inside the tool result (Req 4.4): a denial is
        // an isError tool result, a pending approval is a normal result whose
        // payload carries the approvalId — never a JSON-RPC protocol error.
        return {
          content: [{ type: 'text', text: JSON.stringify(decision) }],
          structuredContent: decision as unknown as Record<string, unknown>,
          isError: decision.status === 'denied',
        };
      }
      default:
        throw new McpProtocolError(METHOD_NOT_FOUND, `Method not supported: ${request.method}`);
    }
  }
}

export class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'McpProtocolError';
  }
}
