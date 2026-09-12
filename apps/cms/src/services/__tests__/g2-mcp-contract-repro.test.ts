import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@lumibase/database';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';
import { McpService, type McpHarnessPort } from '../mcp-service';
import { ToolRegistryService } from '../tool-registry-service';

/**
 * G2 (#454) — reproduction only. NO implementation change accompanies this file.
 *
 * The B-02 handoff asks for reproduced failures before any fix, on the current
 * tree (not the older baseline claims). Each `it` below documents ONE gap and
 * asserts the CURRENT (wrong) behaviour, so a later fix flips it deliberately
 * rather than silently. The "expected contract" is stated in each comment.
 *
 * Selection per handoff: one read (`listVersions` / `listCollections`), one
 * content write (`createItem`), one schema write + delete (`createCollection`,
 * `deleteCollection`).
 */

/** Registry stub: no `agent_tools` overrides, so core metadata is unmodified. */
function registryDb(overrides: unknown[] = []): Database {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(overrides),
    then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(overrides).then(resolve),
  };
  return { select: () => chain } as unknown as Database;
}

function toolsListVia(registry: ToolRegistryService) {
  const port: McpHarnessPort = {
    listTools: async () =>
      (await registry.listTools()).map(({ name, description, inputSchema, enabled }) => ({
        name,
        description,
        inputSchema,
        enabled,
      })),
    execute: async () => ({ status: 'denied' as const, message: 'not used' }),
  };
  return new McpService(port).handle(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ['*'],
  );
}

describe('G2 repro · HTTP MCP advertises unusable tool schemas', () => {
  it('R1: every core tool advertises a bare {type:"object"} — no properties, no required', async () => {
    const registry = new ToolRegistryService(registryDb(), 'site_1', CORE_SKILLS);
    const response = await toolsListVia(registry);
    const tools = (response!.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;

    expect(tools.length).toBeGreaterThan(50);

    // CURRENT: not one advertised schema declares properties or required.
    // EXPECTED: an MCP client can construct a valid call from tools/list alone.
    const withProperties = tools.filter((t) => t.inputSchema['properties'] !== undefined);
    const withRequired = tools.filter((t) => t.inputSchema['required'] !== undefined);
    expect(withProperties).toEqual([]);
    expect(withRequired).toEqual([]);
    expect(tools.every((t) => JSON.stringify(t.inputSchema) === '{"type":"object"}')).toBe(true);
  });

  it('R2: ToolRegistryService.coreTool() discards the inputSchema skills DO declare', async () => {
    // Seven core skills declare a real JSON Schema (listVersions, compareVersion,
    // createVersion, updateVersion, deleteVersion, promoteVersion, generateAppSpec).
    const declaring = Object.entries(CORE_SKILLS).filter(([, s]) => s.inputSchema !== undefined);
    expect(declaring.length).toBeGreaterThan(0);
    expect(CORE_SKILLS['listVersions']!.inputSchema).toMatchObject({
      type: 'object',
      required: ['collection', 'itemId'],
    });

    const registry = new ToolRegistryService(registryDb(), 'site_1', CORE_SKILLS);

    // CURRENT: `coreTool` spreads `...skill` then overwrites `inputSchema: {}`,
    // so the declared contract never reaches the wire.
    // EXPECTED: the declared schema is what tools/list advertises.
    for (const [name] of declaring) {
      const tool = await registry.getTool(name);
      expect(tool!.inputSchema, `${name} kept its declared schema`).toEqual({});
    }
  });
});

describe('G2 repro · no input validation before side effects', () => {
  /** Records every call so we can assert a service was reached with junk. */
  function recordingServices() {
    const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
    const track = (service: string, method: string) => (...args: unknown[]) => {
      calls.push({ service, method, args });
      return Promise.resolve({ id: 'x' });
    };
    const itemService = {
      create: vi.fn(track('itemService', 'create')),
      setProvenance: vi.fn(),
      beginWriteCoalescing: vi.fn(),
      flushCoalescedWrites: vi.fn().mockResolvedValue(undefined),
    };
    const schemaService = { createCollection: vi.fn(track('schemaService', 'createCollection')) };
    return { calls, itemService, schemaService };
  }

  it('R3: content write — createItem with NO collection and NO data still reaches ItemService', async () => {
    const { calls, itemService } = recordingServices();
    const harness = new AISecureHarness({
      db: {} as Database,
      siteId: 'site_1',
      itemService: itemService as never,
      // Legacy path isolates "validate → handler" from run/approval bookkeeping.
      enableAgentHarnessAudit: false,
    });

    // `createItem` is classified SAFE (items:write is not a mutating schema cap
    // and the name is not delete*), so there is no HITL gate in front of it.
    const result = await harness.execute('createItem', {}, ['items:write']);

    // CURRENT: the handler runs and ItemService.create is reached with an
    // undefined collection name — the side-effect attempt happens before any
    // validation of the advertised (empty) input contract.
    // EXPECTED: a schema violation is rejected before the service is touched.
    expect(calls.map((c) => `${c.service}.${c.method}`)).toContain('itemService.create');
    const [collection, payload] = calls[0]!.args as [unknown, { data: unknown }];
    expect(collection).toBeUndefined();
    expect(payload.data).toEqual({});
    expect(result.status).toBe('executed');
  });

  it('R4: schema write — createCollection with NO name reaches SchemaService after approval', async () => {
    const { calls, schemaService } = recordingServices();
    const harness = new AISecureHarness({
      db: {} as Database,
      siteId: 'site_1',
      schemaService: schemaService as never,
      enableAgentHarnessAudit: false,
    });

    // runSkill is the shared execution entry for BOTH the direct path and the
    // post-approval path (`executeApproved` → `runSkill`), so validating here
    // covers what an approved dangerous action would do.
    const outcome = await harness.runSkill('createCollection', {});

    // CURRENT: `args['name'] as string` casts undefined and calls the service.
    // EXPECTED: rejected as a schema violation, service untouched.
    expect(calls.map((c) => `${c.service}.${c.method}`)).toContain('schemaService.createCollection');
    expect((calls[0]!.args[0] as { name: unknown }).name).toBeUndefined();
    expect(outcome.success).toBe(true);
  });

  it('R5: delete — deleteItem with NO arguments still books a pending approval', async () => {
    const inserted: unknown[] = [];
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          inserted.push(v);
          return { returning: () => Promise.resolve([{ id: 'apr_repro_1' }]) };
        },
      }),
    } as unknown as Database;

    const harness = new AISecureHarness({ db, siteId: 'site_1', enableAgentHarnessAudit: false });
    const result = await harness.execute('deleteItem', {}, ['*']);

    // CURRENT: an un-executable call still creates an approval row and hands a
    // human a real approval ID for arguments that can never succeed.
    // EXPECTED: invalid input is rejected before any approval is written.
    expect(result.status).toBe('pending_approval');
    expect(result.approvalId).toBe('apr_repro_1');
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { arguments: unknown }).arguments).toEqual({});
  });
});

describe('G2 repro · the harness capability model is not the REST RBAC model', () => {
  /**
   * `withAuth` sets `roles` to `[membership.roleId]` (a nanoid FK into the roles
   * table) for a normal user, `['admin']` only for a bootstrap user, and `[]`
   * for an API-key principal (apps/cms/src/middleware/auth.ts:263, :380).
   * Both `/api/v1/mcp` and `/api/v1/agent` pass that array straight into
   * `harness.execute(..., auth.roles ?? [])` as the capability set, where
   * `checkCapabilities` does plain string membership against
   * `requiredCapabilities` like `items:write`.
   *
   * REST, by contrast, resolves `PermissionService.canAccess(resource, action)`
   * against the policy DSL. The two transports therefore authorize through two
   * unrelated models — the drift #454 asks to collapse.
   */
  const harness = new AISecureHarness({ db: {} as Database, siteId: 'site_1' });

  it('R7: a real (non-bootstrap) role id satisfies no skill capability — reads included', async () => {
    const roleIdAsRole = ['role_v1StGXR8Z5jdHi6BmyT'];

    // CURRENT: capabilities never expand from role → policy, so the check can
    // only ever pass on the literal strings 'admin' / '*' / 'items:read'…
    // EXPECTED: one authorization model shared with REST.
    expect(harness.checkCapabilities(CORE_SKILLS['listItems']!, roleIdAsRole)).toBe(false);
    expect(harness.checkCapabilities(CORE_SKILLS['createItem']!, roleIdAsRole)).toBe(false);
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, roleIdAsRole)).toBe(false);

    const denied = await harness.execute('listItems', { collection: 'posts' }, roleIdAsRole);
    expect(denied.status).toBe('denied');
    expect(denied.message).toBe('Insufficient capabilities');
  });

  it('R8: an API-key principal (roles: []) is denied every HTTP MCP tool, but keeps full REST reach', async () => {
    const apiKeyCapabilities: string[] = [];

    for (const skill of ['listCollections', 'listItems', 'createItem', 'deleteItem']) {
      expect(
        harness.checkCapabilities(CORE_SKILLS[skill]!, apiKeyCapabilities),
        `${skill} denied for an API key`,
      ).toBe(false);
    }

    // CURRENT: the same API key drives the whole npm stdio surface, because
    // that path authorizes via REST + PermissionService instead. The transports
    // grant different reach for one identical token.
    const denied = await harness.execute('listCollections', {}, apiKeyCapabilities);
    expect(denied.status).toBe('denied');
    expect(denied.message).toBe('Insufficient capabilities');
  });

  it('R9: only the literal admin/wildcard role clears the gate — the check is effectively binary', () => {
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, ['admin'])).toBe(true);
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, ['*'])).toBe(true);
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, ['administrator'])).toBe(false);
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, ['editor'])).toBe(false);
  });
});

describe('G2 repro · the two transports are separate contracts', () => {
  it('R10: HTTP MCP tool names and npm stdio tool names do not intersect', async () => {
    const registry = new ToolRegistryService(registryDb(), 'site_1', CORE_SKILLS);
    const httpNames = new Set((await registry.listTools()).map((t) => t.name));

    // Representative stdio names, from packages/mcp-server/src/tools/*.
    // (Full list asserted in the packages/mcp-server companion repro.)
    const stdioNames = [
      'list_items',
      'get_item',
      'create_item',
      'update_item',
      'delete_item',
      'create_collection',
      'delete_collection',
    ];

    // CURRENT: camelCase harness skills vs snake_case REST wrappers — zero
    // overlap, so "one authoritative contract" does not exist today.
    // EXPECTED: one canonical tool contract both transports serve.
    for (const name of stdioNames) {
      expect(httpNames.has(name), `${name} exists on the HTTP MCP surface`).toBe(false);
    }
    expect(httpNames.has('createItem')).toBe(true);
    expect(httpNames.has('deleteCollection')).toBe(true);
  });
});
