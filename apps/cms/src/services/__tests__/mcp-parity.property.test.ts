import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  McpService,
  toToolDecision,
  type McpHarnessPort,
  type McpToolDecision,
} from '../mcp-service';
import type { HarnessExecutionResult } from '../ai-harness';

/**
 * Feature: content-os, Property 14: MCP parity.
 *
 * The MCP server is a thin adapter over the same harness codepath as the
 * Agent API (design decision 5). For any tool + input + capability set, the
 * decision visible through `tools/call` (executed / pending_approval /
 * denied) is exactly the decision the harness returns directly — and a
 * `pending_approval` always carries the approvalId in the tool result, not
 * a protocol error (Req 4.2, 4.4).
 *
 * **Validates: Requirements 4.2, 4.4**
 */

const nameArb = fc
  .string({ minLength: 1, maxLength: 24 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));
const argsArb = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 16 }).filter((s) => /^[a-zA-Z_]/.test(s)),
  fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  { minKeys: 0, maxKeys: 5 },
);
const capabilitiesArb = fc.array(
  fc.constantFrom('items:read', 'items:write', 'schema:read', 'schema:write', '*'),
  { minLength: 0, maxLength: 4 },
);
const statusArb = fc.constantFrom<'executed' | 'pending_approval' | 'denied'>(
  'executed',
  'pending_approval',
  'denied',
);

/**
 * Deterministic stand-in for the harness: the decision is a pure function of
 * (skill, args, capabilities), so calling it through MCP and "through the
 * Agent API" (directly) must agree.
 */
function decisionPort(
  decide: (skill: string, args: Record<string, unknown>, caps: string[]) => HarnessExecutionResult,
): McpHarnessPort {
  return {
    listTools: async () => [],
    execute: async (skill, args, caps) => decide(skill, args, caps),
  };
}

function harnessResultFor(
  status: 'executed' | 'pending_approval' | 'denied',
  seed: string,
): HarnessExecutionResult {
  if (status === 'executed') return { status, data: { ok: true, seed }, runId: `run_${seed}` };
  if (status === 'pending_approval') {
    return { status, agentApprovalId: `apr_${seed}`, runId: `run_${seed}`, message: 'Awaiting approval' };
  }
  return { status, message: 'Capability missing' };
}

async function callViaMcp(
  service: McpService,
  name: string,
  args: Record<string, unknown>,
  caps: string[],
): Promise<{ decision: McpToolDecision; isError: boolean }> {
  const response = await service.handle(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    caps,
  );
  expect(response?.error).toBeUndefined();
  const result = response!.result as {
    structuredContent: McpToolDecision;
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };
  // The text content mirrors structuredContent for clients without
  // structured-output support.
  expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  return { decision: result.structuredContent, isError: result.isError };
}

describe('Feature: content-os, Property 14: MCP parity', () => {
  it('tools/call decision equals the direct harness decision for any input', async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, argsArb, capabilitiesArb, async (name, args, caps) => {
        // Decision derived deterministically from the inputs.
        const decide = (skill: string, a: Record<string, unknown>, c: string[]): HarnessExecutionResult => {
          const weight = (skill.length + Object.keys(a).length + c.length) % 3;
          const status = (['executed', 'pending_approval', 'denied'] as const)[weight]!;
          return harnessResultFor(status, skill);
        };
        const port = decisionPort(decide);
        const service = new McpService(port);

        const direct = toToolDecision(await port.execute(name, args, caps));
        const viaMcp = await callViaMcp(service, name, args, caps);

        expect(viaMcp.decision).toEqual(direct);
      }),
      { numRuns: 150 },
    );
  });

  it('pending_approval surfaces approvalId in the tool result, never a protocol error', async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, argsArb, async (name, args) => {
        const service = new McpService(
          decisionPort((skill) => harnessResultFor('pending_approval', skill)),
        );
        const { decision, isError } = await callViaMcp(service, name, args, []);
        expect(decision.status).toBe('pending_approval');
        expect(decision.approvalId).toBe(`apr_${name}`);
        expect(isError).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('denied maps to an isError tool result; executed never does', async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, argsArb, statusArb, async (name, args, status) => {
        const service = new McpService(decisionPort((skill) => harnessResultFor(status, skill)));
        const { decision, isError } = await callViaMcp(service, name, args, ['*']);
        expect(decision.status).toBe(status);
        expect(isError).toBe(status === 'denied');
      }),
      { numRuns: 100 },
    );
  });

  it('capabilities pass through to the harness verbatim', async () => {
    await fc.assert(
      fc.asyncProperty(nameArb, capabilitiesArb, async (name, caps) => {
        let seen: string[] | undefined;
        const service = new McpService({
          listTools: async () => [],
          execute: async (_skill, _args, c) => {
            seen = c;
            return harnessResultFor('executed', name);
          },
        });
        await callViaMcp(service, name, {}, caps);
        expect(seen).toEqual(caps);
      }),
      { numRuns: 100 },
    );
  });
});

describe('MCP protocol surface', () => {
  it('tools/list exposes only enabled tools and defaults inputSchema to an object schema', async () => {
    const service = new McpService({
      listTools: async () => [
        { name: 'a', description: 'enabled tool', inputSchema: { type: 'object', properties: {} }, enabled: true },
        { name: 'b', description: 'disabled tool', enabled: false },
        { name: 'c', description: 'no schema tool' },
      ],
      execute: async () => harnessResultFor('executed', 'x'),
    });
    const response = await service.handle({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, []);
    const tools = (response!.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['a', 'c']);
    expect(tools[1]!.inputSchema).toEqual({ type: 'object' });
  });

  it('initialize negotiates a supported protocol version', async () => {
    const service = new McpService({ listTools: async () => [], execute: async () => harnessResultFor('executed', 'x') });
    const response = await service.handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      [],
    );
    const result = response!.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.serverInfo.name).toBe('lumibase-mcp');
  });

  it('notifications return null (202), unknown methods return -32601, bad calls -32602', async () => {
    const service = new McpService({ listTools: async () => [], execute: async () => harnessResultFor('executed', 'x') });
    expect(await service.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, [])).toBeNull();
    const unknown = await service.handle({ jsonrpc: '2.0', id: 2, method: 'nope/nope' }, []);
    expect(unknown!.error?.code).toBe(-32601);
    const badParams = await service.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} }, []);
    expect(badParams!.error?.code).toBe(-32602);
    const invalid = await service.handle({ hello: 'world' }, []);
    expect(invalid!.error?.code).toBe(-32600);
  });
});
