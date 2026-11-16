import { describe, expect, it } from 'vitest';
import { CORE_SKILLS } from '../ai-harness';
import { McpService, type McpHarnessPort } from '../mcp-service';
import { OrganizationHarness } from '../organization-harness';
import { ToolRegistryService } from '../tool-registry-service';

/**
 * Golden `tools/list` for the HTTP MCP transport (#716).
 *
 * What is pinned: the exact `{ name, description, inputSchema }` list that
 * `POST /api/v1/mcp` (site key) and the organization endpoint return, produced
 * through the real `McpService` projection over `ToolRegistryService` and
 * `OrganizationHarness` — the same objects `routes/mcp.ts` wires, minus the
 * database (no `agent_tools` overrides, which is what a fresh site advertises).
 *
 * Why it lives in another package's folder: `packages/mcp-server` holds the
 * JSON Schema validator and the field-type matrix that consume this list
 * (`src/__tests__/fidelity/`), and it cannot import `apps/cms`. This file is the
 * half that proves the committed golden still equals the live server; the
 * mcp-server half proves every schema in it is valid JSON Schema and agrees with
 * what the harness accepts. Same split as `canonical-agent-tool-schemas.json`.
 *
 * An intended change: run `pnpm -F @lumibase/cms exec vitest run
 * src/services/__tests__/mcp-tool-schema-golden.test.ts -u`, then review the
 * diff of the golden like any other API change. CI never writes it (`CI=true`
 * makes a mismatch or a missing file fail).
 */

const GOLDEN = '../../../../../packages/mcp-server/src/__tests__/fidelity/golden/http-tools-list.json';

/** `db.select().from(t).where(…)` resolving to no `agent_tools` overrides. */
const noOverridesDb = {
  select: () => ({ from: () => ({ where: async () => [] }) }),
} as never;

async function toolsList(port: McpHarnessPort, context: { organizationId?: string } = {}) {
  const response = await new McpService(port, context).handle(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    [],
  );
  return (response?.result as { tools: Array<Record<string, unknown>> }).tools;
}

describe('HTTP MCP tools/list golden', () => {
  it('site and organization endpoints advertise exactly the committed golden', async () => {
    const registry = new ToolRegistryService(noOverridesDb, 'site_golden', CORE_SKILLS);
    // Same projection as `routes/mcp.ts` (`port.listTools`).
    const sitePort: McpHarnessPort = {
      listTools: async () =>
        (await registry.listTools()).map(({ name, description, inputSchema, enabled }) => ({
          name,
          description,
          inputSchema,
          enabled,
        })),
      execute: async () => ({ status: 'denied' }) as never,
    };
    const organizationPort = new OrganizationHarness({} as never);

    const golden = {
      site: await toolsList(sitePort),
      organization: await toolsList(organizationPort, { organizationId: 'org_golden' }),
    };

    expect(golden.site.length).toBeGreaterThan(70);
    expect(golden.organization.length).toBeGreaterThan(5);
    await expect(`${JSON.stringify(golden, null, 2)}\n`).toMatchFileSnapshot(GOLDEN);
  });
});
