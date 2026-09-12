import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { LumiBaseClient } from '../client.js';
import { registerAllTools } from '../tools/index.js';

/**
 * G2 (#454) — reproduction only, npm stdio side. NO implementation change.
 *
 * Companion to `apps/cms/src/services/__tests__/g2-mcp-contract-repro.test.ts`.
 * Every assertion below describes the CURRENT stdio contract so that a later
 * fix flips it deliberately.
 *
 * ── Evidence classes used here (reviewer P2) ─────────────────────────────────
 * - **REAL MCP client/server**: `S1`, `S3`, `S4` drive an actual
 *   `@modelcontextprotocol/sdk` `Client` against an actual `McpServer` over
 *   `InMemoryTransport`, so `tools/list` and `tools/call` go through the SDK's
 *   own dispatch and schema validation. No DB, no network, no live CMS.
 * - **FAKE CMS transport**: `LumiBaseClient` is replaced by a recorder, so
 *   "reached the CMS" means "the tool handler issued this REST call", not
 *   "the CMS executed it". No claim here depends on CMS-side behaviour.
 *
 * Nothing in this file constitutes a DB roundtrip, an approval roundtrip, or a
 * live cross-tenant test.
 */

interface CapturedTool {
  config: { description?: string; inputSchema?: Record<string, z.ZodTypeAny> };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Records the method+path+body of every REST call a tool handler issues. */
function fakeClient() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const record = (method: string) => (path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return Promise.resolve({ ok: true });
  };
  const client = {
    get: vi.fn(record('GET')),
    post: vi.fn(record('POST')),
    patch: vi.fn(record('PATCH')),
    put: vi.fn(record('PUT')),
    delete: vi.fn(record('DELETE')),
    getText: vi.fn((path: string) => {
      calls.push({ method: 'GET_TEXT', path });
      return Promise.resolve('ndjson');
    }),
    getRootText: vi.fn((path: string) => {
      calls.push({ method: 'GET_ROOT', path });
      return Promise.resolve('ok');
    }),
    postRaw: vi.fn((path: string, body: unknown) => {
      calls.push({ method: 'POST_RAW', path, body });
      return Promise.resolve({ ok: true });
    }),
  };
  return { client: client as unknown as LumiBaseClient, calls };
}

/** Registry-only view: captures what `registerAllTools` declares. */
function registryOnly() {
  const tools = new Map<string, CapturedTool>();
  const server = {
    registerTool(name: string, config: CapturedTool['config'], handler: CapturedTool['handler']) {
      if (tools.has(name)) throw new Error(`Duplicate tool name: ${name}`);
      tools.set(name, { config, handler });
    },
  };
  const { client, calls } = fakeClient();
  registerAllTools(server as never, client);
  return { tools, calls };
}

const openConnections: Array<() => Promise<void>> = [];

/**
 * Boots a REAL MCP server with the REAL tool registry and a REAL MCP client
 * linked in memory. Returns the client plus the recorder of REST calls the
 * handlers issue, so a call that never reaches the recorder never ran.
 */
async function liveClient() {
  const server = new McpServer({ name: 'lumibase', version: 'test' });
  const { client: cmsClient, calls } = fakeClient();
  registerAllTools(server, cmsClient);

  const client = new Client({ name: 'g2-repro-client', version: 'test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  openConnections.push(async () => {
    await client.close();
    await server.close();
  });

  return { client, calls };
}

afterEach(async () => {
  while (openConnections.length > 0) {
    await openConnections.pop()!();
  }
});

describe('G2 repro · stdio transport never reaches the governed harness', () => {
  it('S1: every probed stdio tool call is a plain REST call — no /mcp, no /agent/skills [REAL MCP client]', async () => {
    const { client, calls } = await liveClient();

    // One content write, one schema write, one schema delete, one read — the
    // four probes the handoff asked for, issued through a real MCP client.
    await client.callTool({
      name: 'create_item',
      arguments: { collection: 'posts', data: { title: 'x' }, status: 'draft' },
    });
    await client.callTool({ name: 'create_collection', arguments: { name: 'posts' } });
    await client.callTool({ name: 'delete_collection', arguments: { name: 'posts', confirm: true } });
    await client.callTool({ name: 'list_items', arguments: { collection: 'posts' } });

    const paths = calls.map((c) => `${c.method} ${c.path}`);

    // CURRENT: these four land on the ordinary REST surface. The harness —
    // kill switch, capability gate, autonomy resolution, HITL approval, veto
    // window, agent_runs / agent_tool_calls audit — is never entered.
    // EXPECTED: a governed tool call is governed on BOTH transports.
    // SCOPE: four probes, not the whole registry. The registry-wide statement
    // is S4's naming invariant, not this test.
    expect(paths).toContain('POST /items/posts');
    expect(paths).toContain('POST /collections');
    expect(paths).toContain('DELETE /collections/posts');
    // The read carries the schema's applied defaults as a query string
    // (`?limit=25&offset=0`), so match on the route rather than the full path.
    expect(paths.some((p) => p.startsWith('GET /items/posts'))).toBe(true);
    expect(paths.some((p) => p.includes('/mcp'))).toBe(false);
    expect(paths.some((p) => p.includes('/agent/skills'))).toBe(false);
  });

  it('S2: a dangerous probed tool returns no approval id — confirm is a prompt, not a gate', async () => {
    const { tools, calls } = registryOnly();

    // `delete_collection` is the stdio counterpart of the HTTP MCP
    // `deleteCollection` skill. On HTTP MCP that skill is control-plane +
    // dangerous: it parks a pending approval and additionally requires an
    // admin principal via the `mcp.ts` backstop.
    const result = (await tools.get('delete_collection')!.handler({
      name: 'posts',
      confirm: true,
    })) as unknown;

    // CURRENT: the DELETE is issued straight away and the result carries no
    // approvalId / pending status.
    // EXPECTED: the same governed skill parks identically on both transports.
    //
    // IMPORTANT — what this does NOT say: it does not say this REST route is
    // unauthorized. `DELETE /collections/:name` enforces
    // `requireSchemaPermission('schema:delete')`. The missing gate is AGENT
    // governance (autonomy/HITL/kill switch), not RBAC. See S5 for the
    // per-prefix guard split.
    expect(calls.map((c) => c.method)).toContain('DELETE');
    expect(JSON.stringify(result)).not.toMatch(/approvalId|pending_approval/);
  });

  it('S3: the SDK rejects missing and wrong-typed input before the handler runs [REAL MCP client]', async () => {
    const { client, calls } = await liveClient();

    // (a) required field missing entirely
    const missing = await client
      .callTool({ name: 'create_item', arguments: {} })
      .catch((err: unknown) => ({ thrown: err }));

    // (b) required field present but wrong type
    const wrongType = await client
      .callTool({ name: 'create_item', arguments: { collection: 123, data: 'not-an-object' } })
      .catch((err: unknown) => ({ thrown: err }));

    // (c) `confirm: z.literal(true)` violated on a destructive tool
    const badLiteral = await client
      .callTool({ name: 'delete_item', arguments: { collection: 'posts', id: 'i1', confirm: false } })
      .catch((err: unknown) => ({ thrown: err }));

    // The decisive assertion: NO handler ran, so no REST call was issued for
    // any of the three invalid calls. This is what distinguishes real
    // validation from a schema that merely exists — a `z.any()` shape or a
    // bypassed validator would let the handler through and record a call here.
    expect(calls).toEqual([]);

    // Each invalid call surfaced as an error, and specifically as a JSON-RPC
    // INVALID_PARAMS (-32602) *input validation* failure naming the offending
    // field. Asserting the reason — not merely "some error" — is what makes
    // this test fail if a schema is loosened to `z.any()` or the validator is
    // bypassed: those produce a success, or an error for a different reason.
    const reasons = [missing, wrongType, badLiteral].map((outcome) => {
      const text = JSON.stringify(outcome);
      expect(text).toMatch(/-32602/);
      expect(text).toMatch(/[Ii]nput validation error/);
      return text;
    });
    expect(reasons[0]).toMatch(/expected string, received undefined at collection/);
    expect(reasons[1]).toMatch(/expected string, received number at collection/);
    expect(reasons[2]).toMatch(/expected true at confirm/);

    // Control: the same tool with valid input DOES reach the CMS, proving the
    // three cases above were rejected on their input and not on plumbing.
    await client.callTool({
      name: 'create_item',
      arguments: { collection: 'posts', data: { title: 'ok' } },
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /items/posts']);
  });

  it('S4: the FULL advertised registry is snake_case — disjoint from camelCase skills by construction [REAL MCP client]', async () => {
    const { client } = await liveClient();
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);

    // Full inventory, not a sample: every advertised name is checked against
    // the naming invariant. Because HTTP MCP tool names are exactly the
    // `CORE_SKILLS` keys and those are all camelCase (asserted registry-wide
    // on the CMS side, R9), "no stdio name contains an uppercase letter"
    // proves the two registries are disjoint without cross-importing either.
    expect(names.length).toBeGreaterThan(60);
    const withUppercase = names.filter((n) => /[A-Z]/.test(n));
    expect(withUppercase).toEqual([]);
    expect(names.every((n) => /^[a-z][a-z0-9_]*$/.test(n))).toBe(true);

    // And the corollary, stated directly.
    for (const skillName of ['createItem', 'deleteItem', 'createCollection', 'deleteCollection', 'listItems']) {
      expect(names, `${skillName} is absent from the stdio surface`).not.toContain(skillName);
    }
  });
});

describe('G2 repro · the admin backstop is per-prefix, not per-transport', () => {
  it('S5: many stdio tools DO sit behind withControlPlaneAccessGuard — the gap is tool-specific', async () => {
    const { tools } = registryOnly();

    /**
     * Correction to the first version of this audit, which said "stdio has no
     * admin backstop" as a transport-wide statement. That is wrong.
     * `withControlPlaneAccessGuard` (apps/cms/src/middleware/control-plane-access-guard.ts)
     * gates these REST prefixes for non-admin principals:
     *
     *   /api/v1/access · /api/v1/api-keys · /api/v1/admin · /api/v1/agent
     *   /api/v1/cdc · /api/v1/flows · /api/v1/integrations/git
     *   /api/v1/materialize · /api/v1/permissions · /api/v1/policies
     *   /api/v1/roles · /api/v1/settings · /api/v1/teams · /api/v1/users
     *   /api/v1/utils/cache
     *
     * So a stdio tool targeting one of those IS admin-gated. The gap is
     * confined to prefixes NOT on that list — notably `/collections`,
     * `/fields` and `/items`, which rely on per-route schema/item permission
     * instead.
     *
     * Whether the HTTP MCP counterpart adds an admin backstop is decided
     * per-SKILL by `isControlPlaneSkill`, NOT per-prefix — see the per-tool
     * breakdown at the end of this test. Conflating the two produced a wrong
     * claim in an earlier revision.
     *
     * This test pins the classification so the audit table cannot drift back
     * to the over-broad claim. It reads the tool's own declared REST target,
     * so it is registry evidence — not proof that the CMS enforced anything.
     */
    const GUARDED_PREFIXES = [
      '/access', '/api-keys', '/admin', '/agent', '/cdc', '/flows',
      '/integrations/git', '/materialize', '/permissions', '/policies',
      '/roles', '/settings', '/teams', '/users', '/utils/cache',
    ];
    const isGuarded = (path: string) =>
      GUARDED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

    /** Runs one tool on a fresh recorder and returns the REST path it targeted. */
    async function restTargetOf(name: string, args: Record<string, unknown>): Promise<string> {
      const fresh = registryOnly();
      const entry = fresh.tools.get(name);
      expect(entry, `${name} is registered`).toBeDefined();
      await entry!.handler(args);
      expect(fresh.calls.length, `${name} issued exactly one REST call`).toBe(1);
      return fresh.calls[0]!.path;
    }

    // Sanity: the tools under test exist on this surface.
    for (const name of ['delete_role', 'revoke_api_key', 'delete_flow', 'delete_collection', 'create_item']) {
      expect(tools.has(name), `${name} registered`).toBe(true);
    }

    // Admin-guarded prefixes: stdio adds no gate of its own, but the REST route
    // it targets is behind the control-plane backstop, so a non-admin token
    // cannot drive these.
    expect(isGuarded(await restTargetOf('delete_role', { id: 'r1', confirm: true }))).toBe(true);
    expect(isGuarded(await restTargetOf('revoke_api_key', { id: 'k1', confirm: true }))).toBe(true);
    expect(isGuarded(await restTargetOf('delete_flow', { id: 'f1', confirm: true }))).toBe(true);

    // Un-guarded prefixes: `/collections` and `/items` are NOT in the
    // control-plane list, so they rely on per-route schema/item permission only.
    expect(isGuarded(await restTargetOf('delete_collection', { name: 'posts', confirm: true }))).toBe(false);
    expect(isGuarded(await restTargetOf('delete_item', { collection: 'posts', id: 'i1', confirm: true }))).toBe(false);
    expect(
      isGuarded(await restTargetOf('create_item', { collection: 'posts', data: { t: 1 } })),
    ).toBe(false);

    // ── The asymmetry, stated precisely (review correction) ────────────────
    // An earlier version of this comment claimed `/items` tools are "admin-gated
    // on HTTP MCP". That was WRONG for `create_item`: `isControlPlaneSkill` is
    // FALSE for `createItem` (items:write is not a mutating `schema:*` cap and
    // the name is not `delete*`), so the `mcp.ts` backstop does not apply to it
    // on either transport. The old assertion could not catch the error because
    // it only checked the REST prefix list, which is identical either way.
    //
    // Correct picture, per tool:
    //
    //   delete_item / deleteItem
    //     stdio → DELETE /items/:c/:id · un-guarded prefix · no agent governance
    //     HTTP  → control-plane (delete* rule) ⇒ admin backstop + HITL
    //     ⇒ genuine asymmetry in BOTH admin gating and agent governance.
    //
    //   delete_collection / deleteCollection
    //     stdio → DELETE /collections/:name · un-guarded prefix · schema:delete only
    //     HTTP  → control-plane (schema:delete) ⇒ admin backstop + HITL
    //     ⇒ genuine asymmetry in BOTH.
    //
    //   create_item / createItem
    //     stdio → POST /items/:c · un-guarded prefix · RBAC via PermissionService
    //     HTTP  → NOT control-plane ⇒ NO admin backstop either
    //     ⇒ asymmetry ONLY in agent governance (autonomy/HITL/kill switch/audit),
    //        NOT in admin gating. This is also the tool whose L0/L1 gate is
    //        missing entirely on the governed side — see GP2/GP3 in the CMS repro.
    //
    // The HTTP-side classification is asserted where `isControlPlaneSkill` is
    // importable (CMS repro, `R11`), because this package does not depend on
    // `apps/cms` and cannot import it without a manifest change.
  });
});
