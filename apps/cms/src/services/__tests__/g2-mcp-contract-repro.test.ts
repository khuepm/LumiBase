import { describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Database } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../../env';
import { AISecureHarness, CORE_SKILLS, isControlPlaneSkill } from '../ai-harness';
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
  it('R11: the admin backstop is per-SKILL — createItem is NOT control-plane on HTTP either', () => {
    /**
     * Review correction. An earlier revision of the stdio-side `S5` comment
     * claimed `/items` tools gain an admin backstop on HTTP MCP. That is FALSE
     * for `createItem`, and the old assertion could not catch it because it only
     * compared REST prefix lists — which are identical either way.
     *
     * `routes/mcp.ts` gates a `tools/call` on `isControlPlaneSkill(skill, name)`,
     * i.e. per-SKILL, not per-prefix. Pinning it here (the only place the
     * classifier is importable) so the audit table cannot drift back.
     */
    // Genuine asymmetry in BOTH admin gating and agent governance:
    expect(isControlPlaneSkill(CORE_SKILLS['deleteItem']!, 'deleteItem')).toBe(true);
    expect(isControlPlaneSkill(CORE_SKILLS['deleteCollection']!, 'deleteCollection')).toBe(true);

    // Asymmetry ONLY in agent governance — no admin backstop on either side.
    // This is also the tool whose L0/L1 gate is missing (GP2/GP3).
    expect(isControlPlaneSkill(CORE_SKILLS['createItem']!, 'createItem')).toBe(false);
    expect(isControlPlaneSkill(CORE_SKILLS['updateItem']!, 'updateItem')).toBe(false);

    // Reads stay open to non-admins on both transports.
    expect(isControlPlaneSkill(CORE_SKILLS['listItems']!, 'listItems')).toBe(false);
    expect(isControlPlaneSkill(CORE_SKILLS['listCollections']!, 'listCollections')).toBe(false);
  });

  it('R14: mọi skill trong bảng mapping 41 ứng viên PHẢI tồn tại trong CORE_SKILLS thật', () => {
    /**
     * Hàng rào mà `S8` phía stdio không thể dựng (nó không import được registry
     * này). Review vòng 4 đúng: `S8` chỉ chuẩn hoá chuỗi literal, nên xoá/đổi tên
     * skill phía CMS vẫn không làm nó đỏ. `R14` đóng đúng lỗ đó.
     *
     * Nếu ai xoá hoặc đổi tên bất kỳ skill nào dưới đây, test đỏ ngay — nên bảng
     * mapping trong PR không thể trôi khỏi registry thật.
     */
    const MAPPED_SKILLS = [
      // items
      'createItem', 'updateItem', 'deleteItem',
      // schema
      'createCollection', 'deleteCollection', 'deleteField', 'createRelation', 'deleteRelation',
      // access
      'createRole', 'deleteRole', 'createPolicy', 'deletePolicy',
      // automation
      'createFlow', 'deleteFlow', 'runFlow', 'createIntent', 'deleteIntent',
      // config
      'createWebhook', 'updateWebhook', 'deleteWebhook',
      'createTranslation', 'updateTranslation', 'deleteTranslation',
      'upsertSetting', 'deleteSetting',
      // cdc — gồm alias `cdc_subscription_replay` → `replayCdcSubscription`
      'createCdcSubscription', 'deleteCdcSubscription', 'replayCdcSubscription',
      // api keys
      'createApiKey', 'rotateApiKey', 'revokeApiKey',
      // users & teams
      'inviteUser', 'updateUser', 'removeUser',
      'createTeam', 'deleteTeam', 'addTeamMember', 'removeTeamMember',
      // extensions
      'installExtension', 'updateExtension', 'uninstallExtension',
    ];

    // 41 ứng viên mutation map được (40 theo tên + 1 alias).
    expect(MAPPED_SKILLS).toHaveLength(41);
    expect(new Set(MAPPED_SKILLS).size).toBe(41);

    for (const name of MAPPED_SKILLS) {
      expect(CORE_SKILLS[name], `${name} tồn tại trong CORE_SKILLS`).toBeDefined();
      expect(CORE_SKILLS[name]!.name, `${name} khai đúng tên của chính nó`).toBe(name);
    }

    // Chốt riêng ca alias: đây là mắt xích mà camelCase thuần bỏ lọt, nên nó
    // phải được kiểm trên registry thật, không chỉ trên chuỗi.
    expect(CORE_SKILLS['replayCdcSubscription']).toBeDefined();
    expect(CORE_SKILLS['cdcSubscriptionReplay']).toBeUndefined();
  });

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

/**
 * ── ROUTE-LEVEL REPRO (RT1–RT4) ──────────────────────────────────────────────
 *
 * Self-identified gap, not raised in review: the handoff asks to reproduce
 * "list-tools → call", and until now the HTTP side only exercised
 * `McpService` + `ToolRegistryService` in isolation, while the stdio side had a
 * real client. These cases close that asymmetry by driving the actual
 * `POST /api/v1/mcp` handler (`routes/mcp.ts`) over Hono, with the REAL
 * `AISecureHarness`, REAL `ToolRegistryService` and REAL `McpService` — only
 * the database and the runtime bindings are fakes.
 *
 * They live in this file because the B-02 grant covers exactly the two
 * existing repro files; adding a third under `routes/__tests__/` would need a
 * new grant. Noted so the location is a deliberate constraint, not sloppiness.
 *
 * `getContentOsFlags` is stubbed to `{ mcp: true }` because the flag defaults
 * OFF and would otherwise 404 before the handler is reached. That default is
 * itself part of the compatibility matrix, asserted in RT4 — and the DEFAULT
 * value comes from reading `services/feature-flags.ts`, not from RT4 (RT4 only
 * proves `mcp: false` ⇒ 404). Stated because an earlier revision blurred the two.
 */

/**
 * Mutable flag state + a single hoisted mock, so `routes/mcp` is imported
 * exactly ONCE for the whole file. See the perf note on `buildApp` below.
 */
const { flagState } = vi.hoisted(() => ({
  flagState: { mcp: true, vetoWindow: false } as { mcp: boolean; vetoWindow: boolean },
}));

vi.mock('../feature-flags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../feature-flags')>();
  return { ...actual, getContentOsFlags: async () => flagState };
});

// Imported once, at module load — deliberately outside any test's time budget.
const { mcpRouter } = await import('../../routes/mcp');
describe('G2 repro · route level: POST /api/v1/mcp, real harness, list-tools → call', () => {
  /**
   * `buildApp` chỉ dựng Hono; router đã được import MỘT LẦN ở module scope.
   *
   * Trước đây hàm này gọi `vi.resetModules()` + `await import('../../routes/mcp')`
   * ở **mỗi** test, nên lần đầu phải cold-import cả cây route và tính vào budget
   * của RT1: đo được **18.6s** (reviewer đo ~24.9s) so với 214–357ms của
   * RT2/RT3/RT4. Nguyên nhân là chi phí import, không phải tranh tài nguyên —
   * nên cách sửa là bỏ re-import, KHÔNG nới `testTimeout`.
   */
  function buildApp(auth: AuthPrincipal, db: Database) {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('auth', auth);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_1');
      c.set('db', db as never);
      c.set('runtime', {
        cache: { get: async () => null, set: async () => undefined, invalidateByTag: async () => undefined },
        search: undefined,
        queue: undefined,
        keys: undefined,
        edgeCache: undefined,
        realtime: undefined,
      } as never);
      c.env = {} as never;
      await next();
    });
    app.route('/api/v1/mcp', mcpRouter);
    return app;
  }

  async function rpc(
    app: Hono<AppEnv>,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await app.request('/api/v1/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const ADMIN: AuthPrincipal = { userId: 'u_admin', email: 'admin@example.com', roles: ['admin'], raw: {} };

  it('RT1: tools/list over HTTP advertises {type:"object"} for every tool [end-to-end]', async () => {
    const { db } = governedDb();
    const { body, status } = await rpc(buildApp(ADMIN, db), 'tools/list');

    expect(status).toBe(200);
    const tools = (body.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;

    // Same claim as R1, but now proven through the real route rather than the
    // service in isolation — this is what an MCP client actually receives.
    expect(tools.length).toBeGreaterThan(50);
    expect(tools.every((t) => JSON.stringify(t.inputSchema) === '{"type":"object"}')).toBe(true);
    expect(tools.filter((t) => t.inputSchema['properties'] !== undefined)).toEqual([]);
  });

  it('RT2: a client obeying tools/list still cannot form a valid call — {} passes the advertised schema', async () => {
    const { db } = governedDb();
    const app = buildApp(ADMIN, db);

    // Step 1: discover, exactly as a client would.
    const listed = await rpc(app, 'tools/list');
    const tools = (listed.body.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    const createItem = tools.find((t) => t.name === 'createItem');
    expect(createItem).toBeDefined();

    // Step 2: `{}` fully satisfies the advertised contract `{type:'object'}`,
    // so a well-behaved client has no way to know `collection` is required.
    expect(createItem!.inputSchema).toEqual({ type: 'object' });

    // Step 3: send it. CURRENT: accepted at the boundary, dispatched to the
    // harness, and it fails deep inside the real ItemService — surfacing to the
    // MCP client as a raw JavaScript TypeError:
    //
    //   {"status":"denied","runId":"…",
    //    "message":"Cannot read properties of undefined (reading 'length')"}
    //
    // Two separate defects in one response:
    //   (a) no input validation at the boundary — the JSON-RPC code is NOT
    //       -32602 and no VALIDATION error is produced;
    //   (b) the internal failure is leaked verbatim as the tool-result message,
    //       so a client sees an engine stack-trace string instead of "field
    //       `collection` is required".
    // EXPECTED: -32602 / a structured VALIDATION denial naming the field,
    // raised before any dispatch.
    const called = await rpc(app, 'tools/call', { name: 'createItem', arguments: {} });
    expect(called.status).toBe(200);
    expect(JSON.stringify(called.body)).not.toMatch(/-32602/);
    expect(JSON.stringify(called.body)).not.toMatch(/[Ii]nput validation error/);

    const decision = (called.body.result as { structuredContent: { status: string; message?: string } })
      .structuredContent;
    expect(decision.status).toBe('denied');
    // Pin the leak so a fix cannot quietly keep it: this must become a
    // structured validation message, not stay an internal TypeError string.
    expect(decision.message).toMatch(/Cannot read properties of undefined/);
    expect(decision.message).not.toMatch(/collection/);
  });

  it('RT3: a dangerous call over HTTP surfaces a governed decision in the tool result', async () => {
    const { db, insertedInto } = governedDb();
    const app = buildApp(ADMIN, db);

    const called = await rpc(app, 'tools/call', {
      name: 'deleteCollection',
      arguments: { name: 'posts' },
    });

    expect(called.status).toBe(200);
    const result = called.body.result as {
      structuredContent: { status: string; approvalId?: string };
      isError?: boolean;
    };

    // The governed decision (pending_approval + an approval id) rides inside
    // the tool result rather than a protocol error — end-to-end confirmation of
    // the design the parity property test only shows against a mock.
    expect(result.structuredContent.status).toBe('pending_approval');
    expect(result.structuredContent.approvalId).toBeDefined();
    expect(result.isError).toBe(false);
    expect(insertedInto('lumibase_ai_approvals')).toHaveLength(1);

    // SCOPE: `approvalId` here comes from the fake insert's `returning()`, not
    // from a database. It shows the id is PROPAGATED to the client; it does not
    // show the id resolves at the decision endpoint. That remains a DB gate.
    //
    // CONTRACT FINDING (new, for §4 of the PR): the id handed to the client is
    // the **`agent_approvals`** id, not the `ai_approvals` id. `execute()`
    // inserts into BOTH tables, and `toToolDecision()` prefers
    // `agentApprovalId ?? approvalId`. Two id spaces therefore exist, decided by
    // two different endpoints (`routes/agent.ts` for agent approvals,
    // `routes/ai.ts` for the legacy ai approvals). "Approval ID dùng được" must
    // state WHICH space the MCP client receives and WHICH endpoint accepts it;
    // otherwise a client can hold a valid-looking id and call the wrong route.
    // Verified here by the id prefix produced by the table-aware fake.
    expect(result.structuredContent.approvalId).toMatch(/^lumibase_agent_approvals_/);
  });

  it('RT4: with contentOs.mcp off (the default) the whole surface 404s — compatibility gate', async () => {
    const { db } = governedDb();
    flagState.mcp = false;
    try {
      const app = buildApp(ADMIN, db);
      const listed = await rpc(app, 'tools/list');
      expect(listed.status).toBe(404);
      expect((listed.body.errors as Array<{ code: string }>)[0]?.code).toBe('MCP_DISABLED');
    } finally {
      flagState.mcp = true;
    }

    // Why this matters to the contract: `contentOs.mcp` defaults OFF, so on
    // most sites `POST /api/v1/mcp` does not exist. Any plan that migrates
    // stdio write tools onto `tools/call` must therefore fail explicitly here
    // rather than fall back to REST — a fallback that triggers exactly when
    // governance is unavailable is a bypass of governance.
  });
});

/**
 * ── R12/R13 — BODY-ENVELOPE REPRO (review vòng 3, P1) ────────────────────────
 *
 * Bảng mapping ở các head trước so "schema quảng bá" với "args mà handler skill
 * đọc", và vì thế **bỏ qua hoàn toàn body REST thật sự được gửi**. Review vòng 3
 * tái hiện hai lỗi baseline mà cách so đó không thể thấy. Đây là nửa CMS của
 * repro: nhận đúng hai body mà stdio phát ra (nửa kia là `S6` trong
 * `packages/mcp-server`, assert chính xác hai body đó) rồi cho chạy qua
 * `itemsRouter` THẬT.
 *
 * Tách hai nửa vì `apps/cms` và `packages/mcp-server` **không phụ thuộc nhau**;
 * nối trực tiếp sẽ cần đổi manifest, vượt grant bước 1.
 *
 * EVIDENCE CLASS: route thật + Zod schema thật; `ItemService` là spy. Không DB,
 * không auth middleware, không network.
 */
describe('G2 repro · body envelope: REST từ chối / âm thầm bỏ nội dung', () => {
  async function buildItemsApp() {
    const created: Array<[string, unknown]> = [];
    const patched: Array<[string, string, unknown]> = [];
    const spy = {
      create: vi.fn((collection: string, payload: unknown) => {
        created.push([collection, payload]);
        return Promise.resolve({ id: 'item_1' });
      }),
      patch: vi.fn((collection: string, id: string, payload: unknown) => {
        patched.push([collection, id, payload]);
        return Promise.resolve({ id });
      }),
      setProvenance: vi.fn(),
      beginWriteCoalescing: vi.fn(),
      flushCoalescedWrites: vi.fn().mockResolvedValue(undefined),
    };

    vi.doMock('../item-service-factory', () => ({
      itemServiceForRequest: () => spy,
      itemServiceForSystem: () => spy,
      permissionServiceForRequest: () => ({ canAccess: async () => true }),
      buildRequestPermissionContext: () => ({}),
    }));
    vi.resetModules();
    const { itemsRouter } = await import('../../routes/items');

    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: 'u1', roles: ['admin'], raw: {} } as AuthPrincipal);
      c.set('siteId', 'site_1');
      c.set('requestId', 'req_1');
      c.set('db', {} as never);
      c.set('runtime', { cache: {}, search: undefined, queue: undefined } as never);
      c.env = {} as never;
      await next();
    });
    app.route('/api/v1/items', itemsRouter);
    return { app, created, patched };
  }

  it('R12: body create_item thật ({title,status} — KHÔNG có envelope data) bị REST trả 400', async () => {
    const { app, created } = await buildItemsApp();

    // Đây đúng là body `packages/mcp-server/src/tools/items.ts` phát ra:
    //   client.post(`/items/${collection}`, { ...itemData, status })
    // tức field của item bị spread ra TOP LEVEL, không bọc trong `data`.
    const res = await app.request('/api/v1/items/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', status: 'draft' }),
    });

    // CURRENT: `createSchema` đòi `data: record` ⇒ 400 VALIDATION, service không
    // hề được gọi.
    // EXPECTED: body phải là `{ data: { title }, status }`.
    //
    // PHẠM VI CLAIM (siết theo review vòng 4): test chứng minh **payload thông
    // thường nêu trong test này** bị từ chối. Nó KHÔNG chứng minh `create_item`
    // "chưa từng chạy được với mọi input" — ví dụ input mà `data` tình cờ là một
    // key của chính item (`{ data: {...} }`) sẽ thoả `createSchema`. Phát biểu
    // "chưa từng chạy được" ở head trước là nói quá.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ code: string }> };
    expect(body.errors[0]?.code).toBe('VALIDATION');
    expect(created).toHaveLength(0);

    // Control: bọc đúng envelope thì qua được.
    const ok = await app.request('/api/v1/items/posts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { title: 'x' }, status: 'draft' }),
    });
    expect(ok.status).toBe(201);
    expect(created).toHaveLength(1);
    expect(created[0]![1]).toMatchObject({ data: { title: 'x' }, status: 'draft' });
  });

  it('R13: body update_item thật ({title} bare) trả 200 nhưng ItemService nhận patch RỖNG', async () => {
    const { app, patched } = await buildItemsApp();

    // Body thật: `client.patch(path, itemData)` — gửi thẳng field, không envelope.
    const res = await app.request('/api/v1/items/posts/item_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new title' }),
    });

    // CURRENT: `patchSchema` có mọi field optional và Zod **strip** key lạ, nên
    // `title` bị loại âm thầm. Kết quả: **200 OK** với patch rỗng.
    // EXPECTED: body phải là `{ data: { title } }`.
    //
    // PHẠM VI CLAIM (siết theo review vòng 4): test chứng minh nội dung update
    // **bị bỏ qua** và response là **success-shaped no-op**. Nó KHÔNG chứng minh
    // dữ liệu cũ trong DB bị xoá hay hỏng — không có DB trong probe này. Nguy ở
    // chỗ client nhận 200 rồi tin là đã cập nhật, không phải ở chỗ mất dữ liệu
    // đã lưu.
    expect(res.status).toBe(200);
    expect(patched).toHaveLength(1);
    expect(patched[0]![2]).toEqual({});

    // Control: bọc đúng envelope thì nội dung tới được service.
    const ok = await app.request('/api/v1/items/posts/item_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { title: 'new title' } }),
    });
    expect(ok.status).toBe(200);
    expect(patched).toHaveLength(2);
    expect(patched[1]![2]).toMatchObject({ data: { title: 'new title' } });
  });
});
