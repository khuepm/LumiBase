import { describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
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
 *
 * ── EVIDENCE CLASSES — read before quoting any result ────────────────────────
 * Every case here is an **in-process unit probe with fakes**. There is no
 * Postgres, no HTTP server, no MCP client and no approval endpoint in this
 * file. Concretely:
 *
 * - `R1`–`R2` — registry metadata only (what `tools/list` would advertise).
 * - `R3`–`R5` — **LEGACY branch** (`enableAgentHarnessAudit: false`) or a direct
 *   `runSkill` call. These do NOT exercise the branch production takes.
 * - `GP1`–`GP5` — **GOVERNED branch** (audit enabled), the branch
 *   `routes/mcp.ts` actually uses, over a table-aware fake db. Rows are
 *   counted, not persisted.
 * - `R6`–`R8` — `checkCapabilities` / legacy `execute` fed hand-built
 *   capability arrays. They describe the SHAPE `withAuth` produces; they do not
 *   authenticate a real user or API key.
 * - `R9` — registry-wide naming invariant.
 *
 * Therefore nothing here is evidence of: a real DB row, a usable approval id,
 * an approval roundtrip, cross-tenant isolation, or retry/duplicate side-effect
 * behaviour. Those remain gated on #453 (G1) plus a disposable DB.
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

  it('R4: schema write — createCollection with NO name reaches SchemaService via runSkill', async () => {
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

  it('R5: delete — deleteItem with NO arguments still ATTEMPTS an approval insert (legacy path, fake db)', async () => {
    const inserted: unknown[] = [];
    const FAKE_ID = 'fake_not_a_db_id';
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          inserted.push(v);
          // Hard-coded. Nothing is stored, nothing is queried back.
          return { returning: () => Promise.resolve([{ id: FAKE_ID }]) };
        },
      }),
    } as unknown as Database;

    const harness = new AISecureHarness({ db, siteId: 'site_1', enableAgentHarnessAudit: false });
    const result = await harness.execute('deleteItem', {}, ['*']);

    // CURRENT: un-executable input still reaches the approval insert, carrying
    // empty `arguments` that can never succeed on approval.
    // EXPECTED: invalid input is rejected before any approval is written.
    //
    // ── SCOPE OF THIS EVIDENCE (reviewer P2) ────────────────────────────────
    // This is the LEGACY branch (`enableAgentHarnessAudit: false`) against a
    // FAKE db. It demonstrates an *insert attempt* with empty arguments and
    // nothing more. It specifically does NOT show:
    //   - a real `ai_approvals` row (nothing is persisted),
    //   - a usable approval id (`FAKE_ID` is hard-coded above, not returned by
    //     any database),
    //   - that the id resolves at the approvals decision endpoint (no route is
    //     called),
    //   - any after-approval execution (`executeApproved` is never invoked).
    // The real approval roundtrip remains a G1/#453 + DB gate. GP4/GP5 above
    // cover the same ordering question on the governed branch.
    expect(result.status).toBe('pending_approval');
    expect(result.approvalId).toBe(FAKE_ID);
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as { arguments: unknown }).arguments).toEqual({});
  });
});

/**
 * Table-aware fake `Database` good enough to drive the **governed** branch of
 * `AISecureHarness.execute()` end to end (kill switch → ensureRun →
 * appendToolCall → getTool → policy → risk → runSkill → finishToolCall →
 * closeRun) without a Postgres instance.
 *
 * EVIDENCE CLASS: in-process fake. Rows are counted, not persisted; no
 * approval route is called. It proves control flow and call ordering, NOT DB
 * behaviour. Anything requiring a real row, a real approval id or a real
 * roundtrip is explicitly out of scope here and left to the G1/G2 DB gate.
 */
function governedDb() {
  const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
  const updates: Array<{ table: string; set: Record<string, unknown> }> = [];
  let seq = 0;

  const rowsFor = (table: string): Record<string, unknown>[] => {
    switch (table) {
      // No active freeze.
      case 'lumibase_agent_freezes':
        return [];
      // No per-site tool override, so core metadata is used as-is.
      case 'lumibase_agent_tools':
        return [];
      // A live, non-cancelled run for isCancelled/closeRun lookups.
      case 'lumibase_agent_runs':
        return [{ id: 'run_1', goalId: 'goal_1', agentName: 'lumibase-copilot', status: 'running', metrics: {} }];
      case 'lumibase_agent_tool_calls':
        return [{ id: 'call_1', toolName: 'createItem' }];
      default:
        return [];
    }
  };

  function selectChain() {
    let table = '';
    const chain: Record<string, unknown> = {
      from(t: unknown) {
        table = getTableName(t as Parameters<typeof getTableName>[0]);
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rowsFor(table)),
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(rowsFor(table)).then(resolve, reject),
    };
    return chain;
  }

  const db = {
    select: () => selectChain(),
    insert: (t: unknown) => {
      const table = getTableName(t as Parameters<typeof getTableName>[0]);
      return {
        values: (values: Record<string, unknown>) => {
          inserts.push({ table, values });
          seq += 1;
          const id = `${table}_${seq}`;
          const result = [{ id, goalId: 'goal_1', agentName: 'lumibase-copilot', status: 'running' }];
          return {
            returning: () => Promise.resolve(result),
            then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
          };
        },
      };
    },
    update: (t: unknown) => {
      const table = getTableName(t as Parameters<typeof getTableName>[0]);
      return {
        set: (set: Record<string, unknown>) => {
          updates.push({ table, set });
          const chain: Record<string, unknown> = {
            where: () => chain,
            returning: () => Promise.resolve(rowsFor(table)),
            then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(rowsFor(table)).then(resolve),
          };
          return chain;
        },
      };
    },
  };

  const insertedInto = (table: string) => inserts.filter((i) => i.table === table);
  return { db: db as unknown as Database, inserts, updates, insertedInto };
}

describe('G2 repro · governed path: an L0 content write executes with no autonomy gate', () => {
  /**
   * Reviewer P1. The earlier probes (R3/R4/R5) all sidestepped the governed
   * branch — two set `enableAgentHarnessAudit: false`, one called `runSkill`
   * directly — so none of them spoke to the acceptance bullet "L0 cannot
   * write; L1 requires the specified approval" on the path production uses.
   *
   * The production MCP route (`routes/mcp.ts`) passes real services, and
   * `hasService` then defaults `agentHarnessEnabled` to true
   * (`ai-harness.ts:2038-2047`), so `execute()` takes the governed branch
   * (`:2142-2143`). These tests drive exactly that branch.
   *
   * The gap they pin: `createItem` is classified **safe**
   * (`items:write` is not a mutating `schema:*` capability and the name is not
   * `delete*`), and `AutonomyService.resolve` is only ever called inside
   * `if (isDangerous)` (`:2288-2294`). Below that branch, `execute()` falls
   * through to "Step 4: Safe skill — execute directly" (`:2456`). Therefore no
   * autonomy level — L0 included — is consulted for a content write.
   *
   * Consequence for the plan in this PR: moving stdio onto HTTP and adding
   * input validation does NOT satisfy the L0/L1 acceptance bullet. A
   * write/autonomy gate is needed that is independent of the dangerous
   * classification, while leaving read behaviour untouched.
   */

  function harnessWith(itemService: unknown, db: Database) {
    return new AISecureHarness({
      db,
      siteId: 'site_1',
      itemService: itemService as never,
      // NOT disabled: this is the governed branch, as in production.
      enableAgentHarnessAudit: true,
    });
  }

  function recordingItemService() {
    const created: Array<{ collection: unknown; payload: unknown }> = [];
    return {
      created,
      service: {
        create: vi.fn((collection: unknown, payload: unknown) => {
          created.push({ collection, payload });
          return Promise.resolve({ id: 'item_1' });
        }),
        setProvenance: vi.fn(),
        beginWriteCoalescing: vi.fn(),
        flushCoalescedWrites: vi.fn().mockResolvedValue(undefined),
      },
    };
  }

  it('GP1: governed branch is genuinely active — a run and a tool call are recorded', async () => {
    const { db, insertedInto } = governedDb();
    const { service } = recordingItemService();

    const result = await harnessWith(service, db).execute(
      'createItem',
      { collection: 'posts', data: { title: 'valid input' } },
      ['items:write'],
    );

    // Proves we are NOT on the legacy path: legacy `executeLegacy` creates no
    // run and no tool call. Guards against the repro silently regressing to
    // the branch reviewer flagged.
    expect(result.status).toBe('executed');
    expect(result.runId).toBeDefined();
    expect(result.toolCallId).toBeDefined();
    expect(insertedInto('lumibase_agent_runs')).toHaveLength(1);
    expect(insertedInto('lumibase_agent_tool_calls')).toHaveLength(1);
  });

  it('GP2: L0 (autonomyCap 0) still performs the content write — zero approvals created', async () => {
    const { db, insertedInto } = governedDb();
    const { created, service } = recordingItemService();

    // `autonomyCap: 0` is the strictest cap an intent can express (L0). It is
    // read ONLY inside the dangerous branch, so a safe skill never sees it.
    const result = await harnessWith(service, db).execute(
      'createItem',
      { collection: 'posts', data: { title: 'valid input' } },
      ['items:write'],
      'L0 content write probe',
      { autonomyCap: 0, agentName: 'lumibase-copilot', agentRole: undefined },
    );

    // CURRENT: the write executes. No approval is parked at L0.
    // EXPECTED (acceptance): L0 cannot write.
    expect(result.status).toBe('executed');
    expect(created).toHaveLength(1);
    expect(created[0]!.collection).toBe('posts');
    expect(insertedInto('lumibase_ai_approvals')).toHaveLength(0);
    expect(insertedInto('lumibase_agent_approvals')).toHaveLength(0);
    // Self-contained proof this ran on the governed branch (legacy records
    // neither), so the case cannot silently regress to the path P1 flagged.
    expect(insertedInto('lumibase_agent_runs')).toHaveLength(1);
    expect(result.toolCallId).toBeDefined();
  });

  it('GP3: L1 (autonomyCap 1) also writes without an approval — same fall-through', async () => {
    const { db, insertedInto } = governedDb();
    const { created, service } = recordingItemService();

    const result = await harnessWith(service, db).execute(
      'createItem',
      { collection: 'posts', data: { title: 'valid input' } },
      ['items:write'],
      'L1 content write probe',
      { autonomyCap: 1, agentName: 'lumibase-copilot' },
    );

    // CURRENT: identical to L0 — the cap has no effect on a safe skill.
    // EXPECTED (acceptance): L1 requires the specified approval.
    expect(result.status).toBe('executed');
    expect(created).toHaveLength(1);
    expect(insertedInto('lumibase_ai_approvals')).toHaveLength(0);
    expect(insertedInto('lumibase_agent_approvals')).toHaveLength(0);
    expect(insertedInto('lumibase_agent_runs')).toHaveLength(1);
    expect(result.toolCallId).toBeDefined();
  });

  it('GP4: control — a DANGEROUS skill at the same cap DOES park, proving the cap is only read there', async () => {
    const { db, insertedInto } = governedDb();
    const { created, service } = recordingItemService();

    // `deleteItem` differs from `createItem` only in classification, not in
    // capability tier. It parks; `createItem` does not. That contrast is the
    // evidence that the gate is bound to `isDangerous`, not to "is a write".
    const result = await harnessWith(service, db).execute(
      'deleteItem',
      { collection: 'posts', id: 'item_1' },
      ['*'],
      'dangerous control probe',
      { autonomyCap: 0, agentName: 'lumibase-copilot' },
    );

    expect(result.status).toBe('pending_approval');
    expect(created).toHaveLength(0);
    expect(insertedInto('lumibase_ai_approvals')).toHaveLength(1);
    expect(insertedInto('lumibase_agent_approvals')).toHaveLength(1);
  });

  it('GP5: validation ordering — the audit tool call is written BEFORE any input check', async () => {
    const { db, inserts } = governedDb();
    const { created, service } = recordingItemService();

    // Invalid input on the governed branch: no `collection`, no `data`.
    const result = await harnessWith(service, db).execute('createItem', {}, ['items:write']);

    // CURRENT: `ensureRun` and `appendToolCall` both persist first, then the
    // handler runs and reaches the service with an undefined collection.
    // EXPECTED: rejected before the service, and before a run is left behind.
    //
    // Reviewer note incorporated: `ensureRun` already ran by this point, so
    // "validate before appendToolCall" is necessary but not sufficient — the
    // fix must also avoid orphaning a `running` run, and must keep any denial
    // audit clearly distinct from a business mutation.
    const order = inserts.map((i) => i.table);
    expect(order.indexOf('lumibase_agent_runs')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('lumibase_agent_tool_calls')).toBeGreaterThan(
      order.indexOf('lumibase_agent_runs'),
    );
    expect(result.status).toBe('executed');
    expect(created).toHaveLength(1);
    expect(created[0]!.collection).toBeUndefined();
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

  it('R6: a real (non-bootstrap) role id satisfies no skill capability — reads included', async () => {
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

  it('R7: an API-key-shaped capability set (roles: []) is denied every probed HTTP MCP skill', async () => {
    // `withAuth` gives API-key principals `roles: []` (middleware/auth.ts:380).
    // This test feeds that SHAPE into the harness; it does not authenticate a
    // real key.
    const apiKeyCapabilities: string[] = [];

    for (const skill of ['listCollections', 'listItems', 'createItem', 'deleteItem']) {
      expect(
        harness.checkCapabilities(CORE_SKILLS[skill]!, apiKeyCapabilities),
        `${skill} denied for an empty capability set`,
      ).toBe(false);
    }

    const denied = await harness.execute('listCollections', {}, apiKeyCapabilities);
    expect(denied.status).toBe('denied');
    expect(denied.message).toBe('Insufficient capabilities');

    // ── SCOPE OF THIS EVIDENCE (reviewer P2) ──────────────────────────────
    // Proven here: with an empty capability array, the harness denies these
    // four skills, on the legacy branch, via `checkCapabilities`.
    // NOT proven here: that one real API key simultaneously enjoys full reach
    // over the stdio surface. That claim needs a live token against both
    // transports and belongs to the DB/live gate. What IS established by
    // source is only the structural difference: REST authorizes through
    // `PermissionService.canAccess` (see `routes/schema-permissions.ts`) while
    // the harness does string membership on `auth.roles` — two unrelated
    // models. The practical consequence for the migration plan is that moving
    // stdio onto `POST /api/v1/mcp` cannot be assumed transparent for
    // API-key callers, not that stdio is currently over-privileged.
  });

  it('R8: only the literal admin/wildcard role clears the gate — the check is effectively binary', () => {
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, ['admin'])).toBe(true);
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, ['*'])).toBe(true);
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, ['administrator'])).toBe(false);
    expect(harness.checkCapabilities(CORE_SKILLS['deleteCollection']!, ['editor'])).toBe(false);
  });
});

describe('G2 repro · the two transports are separate contracts', () => {
  it('R9: the FULL HTTP MCP registry is camelCase and contains no snake_case name', async () => {
    const registry = new ToolRegistryService(registryDb(), 'site_1', CORE_SKILLS);
    const httpNames = (await registry.listTools()).map((t) => t.name);

    // Registry-wide, not a sample: every advertised name is checked. Paired
    // with S4 on the stdio side (which asserts its full registry is
    // snake_case), this establishes disjointness by naming invariant without
    // either package importing the other — neither depends on the other, so a
    // literal set intersection is not available without a manifest change.
    expect(httpNames.length).toBeGreaterThan(50);
    expect(httpNames.filter((n) => n.includes('_'))).toEqual([]);
    expect(httpNames.every((n) => /^[a-z][a-zA-Z0-9]*$/.test(n))).toBe(true);

    // Spot-checks of the naming corollary, on top of the registry-wide rule.
    for (const name of ['list_items', 'get_item', 'create_item', 'update_item', 'delete_item', 'create_collection', 'delete_collection']) {
      expect(httpNames, `${name} absent from the HTTP MCP surface`).not.toContain(name);
    }
    expect(httpNames).toContain('createItem');
    expect(httpNames).toContain('deleteCollection');
  });
});
