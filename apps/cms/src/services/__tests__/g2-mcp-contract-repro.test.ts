import { describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { Hono } from 'hono';
import { extensions, type Database } from '@lumibase/database';
import type { AppEnv, AuthPrincipal } from '../../env';
import { AISecureHarness, CORE_SKILLS, isControlPlaneSkill } from '../ai-harness';
import { ExtensionsService } from '../extensions-service';
import { ExtensionVerifierService } from '../extension-verifier';
import { McpService, type McpHarnessPort } from '../mcp-service';
import { ToolRegistryService, overrideNarrowsSchema } from '../tool-registry-service';

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
  it('R1 [REGRESSION]: skill nào khai inputSchema thì tools/list PHẢI quảng bá đúng schema đó', async () => {
    const registry = new ToolRegistryService(registryDb(), 'site_1', CORE_SKILLS);
    const response = await toolsListVia(registry);
    const tools = (response!.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;

    expect(tools.length).toBeGreaterThan(50);

    // Mọi skill khai `inputSchema` phải thấy đúng schema đó trên wire.
    const declaring = Object.entries(CORE_SKILLS).filter(([, s]) => s.inputSchema !== undefined);
    expect(declaring.length).toBeGreaterThan(0);
    for (const [name, skill] of declaring) {
      const advertised = tools.find((t) => t.name === name);
      expect(advertised, `${name} có trong tools/list`).toBeDefined();
      expect(advertised!.inputSchema, `${name} quảng bá đúng schema đã khai`).toEqual(skill.inputSchema);
      expect(advertised!.inputSchema['properties'], `${name} có properties`).toBeDefined();
    }

    // Skill chưa khai schema vẫn rơi về `{type:'object'}` của adapter — đó là
    // khoảng trống còn lại, không phải regression.
    const notDeclaring = tools.filter(
      (t) => CORE_SKILLS[t.name] !== undefined && CORE_SKILLS[t.name]!.inputSchema === undefined,
    );
    expect(notDeclaring.every((t) => JSON.stringify(t.inputSchema) === '{"type":"object"}')).toBe(true);
  });

  it('R2 [REGRESSION]: coreTool() giữ inputSchema đã khai; override chỉ được thu hẹp', async () => {
    // Seven core skills declare a real JSON Schema (listVersions, compareVersion,
    // createVersion, updateVersion, deleteVersion, promoteVersion, generateAppSpec).
    const declaring = Object.entries(CORE_SKILLS).filter(([, s]) => s.inputSchema !== undefined);
    expect(declaring.length).toBeGreaterThan(0);
    expect(CORE_SKILLS['listVersions']!.inputSchema).toMatchObject({
      type: 'object',
      required: ['collection', 'itemId'],
    });

    const registry = new ToolRegistryService(registryDb(), 'site_1', CORE_SKILLS);

    // FIXED: `coreTool` giữ `skill.inputSchema` thay vì hardcode `{}` sau spread.
    for (const [name, skill] of declaring) {
      const tool = await registry.getTool(name);
      expect(tool!.inputSchema, `${name} giữ schema đã khai`).toEqual(skill.inputSchema);
    }

    // Và override chỉ được THU HẸP: bỏ `required` của core thì bị từ chối,
    // giữ nguyên schema core (fail-closed).
    const coreVersions = CORE_SKILLS['listVersions']!.inputSchema!;
    const widened = { type: 'object', properties: { collection: { type: 'string' } }, required: [] };
    expect(overrideNarrowsSchema(coreVersions, widened)).toBe(false);
    const narrowed = {
      type: 'object',
      properties: { collection: { type: 'string' }, itemId: { type: 'string' } },
      required: ['collection', 'itemId'],
    };
    expect(overrideNarrowsSchema(coreVersions, narrowed)).toBe(true);
    // Thêm property lạ cũng là mở rộng ⇒ từ chối.
    expect(
      overrideNarrowsSchema(coreVersions, {
        ...narrowed,
        properties: { ...narrowed.properties, sneaky: { type: 'string' } },
      }),
    ).toBe(false);
  });
});

describe('G2 regression · input is validated before any side effect', () => {
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

  it('R3 [REGRESSION]: createItem with NO collection and NO data never reaches ItemService', async () => {
    const { calls, itemService } = recordingServices();
    const harness = new AISecureHarness({
      db: {} as Database,
      siteId: 'site_1',
      itemService: itemService as never,
      // Legacy path isolates "validate → handler" from run/approval bookkeeping.
      enableAgentHarnessAudit: false,
    });

    // `createItem` is classified SAFE (items:write is not a mutating schema cap
    // and the name is not delete*), so there is no HITL gate in front of it —
    // which is exactly why the input contract has to carry the refusal.
    const result = await harness.execute('createItem', {}, ['items:write']);

    // BEFORE: the handler ran and `ItemService.create(undefined, { data: {} })`
    // was reached, failing deep inside the engine.
    // NOW: refused at the boundary, service untouched, and the denial names the
    // offending field instead of leaking an engine error.
    expect(calls).toHaveLength(0);
    expect(itemService.create).not.toHaveBeenCalled();
    expect(result.status).toBe('denied');
    expect(result.code).toBe('VALIDATION');
    expect(result.message).toContain('collection');
    expect(result.message).toContain('data');
  });

  it('R4 [REGRESSION]: createCollection with NO name is refused by runSkill, service untouched', async () => {
    const { calls, schemaService } = recordingServices();
    const harness = new AISecureHarness({
      db: {} as Database,
      siteId: 'site_1',
      schemaService: schemaService as never,
      enableAgentHarnessAudit: false,
    });

    // runSkill is the shared execution entry for BOTH the direct path and the
    // post-approval path (`executeApproved` → `runSkill`), so validating here
    // covers what an approved dangerous action would do — including one whose
    // stored arguments were mutated between request and decision.
    const outcome = await harness.runSkill('createCollection', {});

    // BEFORE: `args['name'] as string` cast undefined and called the service.
    expect(calls).toHaveLength(0);
    expect(schemaService.createCollection).not.toHaveBeenCalled();
    expect(outcome.success).toBe(false);
    expect(outcome.success === false && outcome.code).toBe('VALIDATION');
    expect(outcome.success === false && outcome.error).toContain('name');
  });

  it('R5 [REGRESSION]: deleteItem with NO arguments writes no approval at all (legacy path, fake db)', async () => {
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

    // BEFORE: un-executable input reached the approval insert, parking an
    // `arguments: {}` row a human could approve and which could then never
    // succeed.
    // NOW: refused before the insert — no approval is created for input that
    // cannot execute.
    //
    // ── SCOPE OF THIS EVIDENCE (reviewer P2) ────────────────────────────────
    // This is the LEGACY branch (`enableAgentHarnessAudit: false`) against a
    // FAKE db, so it proves *ordering*: the insert path is not entered. It does
    // NOT speak to real `ai_approvals` rows or the decision endpoint; the real
    // approval roundtrip remains a G1/#453 + DB gate. `FAKE_ID` stays declared
    // to show what the old assertion consumed — nothing returns it now.
    expect(result.status).toBe('denied');
    expect(result.code).toBe('VALIDATION');
    expect(result.message).toContain('collection');
    expect(result.approvalId).toBeUndefined();
    expect(result.message).not.toContain(FAKE_ID);
    expect(inserted).toHaveLength(0);
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

  it('GP5 [REGRESSION]: invalid input is checked before the run exists — nothing is persisted', async () => {
    const { db, inserts } = governedDb();
    const { created, service } = recordingItemService();

    // Invalid input on the governed branch: no `collection`, no `data`.
    const result = await harnessWith(service, db).execute('createItem', {}, ['items:write']);

    // BEFORE: `ensureRun` then `appendToolCall` both persisted, then the handler
    // ran and reached the service with an undefined collection.
    //
    // The reviewer's point is what drives this assertion: "validate before
    // appendToolCall" would have been necessary but not sufficient, because
    // `ensureRun` had already written a `running` run that nothing would ever
    // close. So the check sits ahead of BOTH writes and this test pins the
    // stronger property — zero rows, not merely a different ordering.
    const order = inserts.map((i) => i.table);
    expect(order).not.toContain('lumibase_agent_runs');
    expect(order).not.toContain('lumibase_agent_tool_calls');
    expect(inserts).toHaveLength(0);

    expect(result.status).toBe('denied');
    expect(result.code).toBe('VALIDATION');
    expect(result.message).toContain('collection');
    expect(created).toHaveLength(0);
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

  it('R15: handlers apply different wrappers to representative service results', async () => {
    /**
     * Nửa CMS của khoảng trống result-shape (review vòng 3 nêu, tôi chưa đo).
     * Nửa stdio là `S10`/`S11`.
     *
     * Chạy handler thật với service giả trả về shape đại diện theo source, rồi
     * đo cách từng handler bọc kết quả. Probe chỉ kết luận wrapper khác nhau ở
     * bốn skill được gọi; không suy rộng sang toàn registry.
     */
    const ROW = { id: 'row_1', __sentinel: 'SERVICE_ROW' };

    // Shape THẬT của service, đọc từ source (sửa theo review vòng 6 — bản trước
    // dùng sentinel row cho mọi method nên kết luận "deleteRole trả row trần"
    // là artefact của mock, không phải hành vi thật):
    //   AccessService.deleteRole       → { deleted: true, id }
    //   SchemaService.deleteCollection → { ok: true }
    const REAL_DELETE_ROLE = { deleted: true, id: 'r1' };
    const REAL_DELETE_COLLECTION = { ok: true } as const;

    const schemaService = {
      createCollection: vi.fn(() => Promise.resolve(ROW)),
      deleteCollection: vi.fn(() => Promise.resolve(REAL_DELETE_COLLECTION)),
    };
    const accessService = {
      createRole: vi.fn(() => Promise.resolve(ROW)),
      deleteRole: vi.fn(() => Promise.resolve(REAL_DELETE_ROLE)),
    };
    const harness = new AISecureHarness({
      db: {} as Database,
      siteId: 'site_1',
      schemaService: schemaService as never,
      accessService: accessService as never,
      enableAgentHarnessAudit: false,
    });

    // Quy ước A — bọc envelope `{<verb>: true, <entity>: row }`
    const created = await harness.runSkill('createCollection', { name: 'posts' });
    expect(created.success).toBe(true);
    expect((created as { data: unknown }).data).toEqual({ created: true, collection: ROW });

    const createdRole = await harness.runSkill('createRole', { name: 'editor' });
    expect((createdRole as { data: unknown }).data).toEqual({ created: true, role: ROW });

    // Quy ước B — **pass-through**: trả thẳng kết quả service, handler không bọc
    const deletedRole = await harness.runSkill('deleteRole', { id: 'r1' });
    expect(deletedRole.success).toBe(true);
    expect((deletedRole as { data: unknown }).data).toEqual(REAL_DELETE_ROLE);

    // …trong khi cùng động từ `delete` ở nhánh schema lại **bọc thêm một lớp**,
    // nên kết quả service bị lồng vào `result`:
    const deletedCollection = await harness.runSkill('deleteCollection', { name: 'posts' });
    expect((deletedCollection as { data: unknown }).data).toEqual({
      deleted: true,
      result: REAL_DELETE_COLLECTION,
    });

    // ── PHẠM VI CLAIM (siết theo review vòng 6) ───────────────────────────
    // Điều test này chứng minh: **cách handler BỌC kết quả không đồng nhất** —
    // `deleteRole` pass-through, `deleteCollection` bọc thêm `{deleted, result}`,
    // dù cả hai service đều đã tự trả cờ. Nên client phải bóc hai kiểu khác nhau
    // cho cùng một loại hành động, trong cùng registry.
    //
    // Điều test này **KHÔNG** chứng minh: rằng mọi cặp trong 41 candidate đều
    // không tương thích về result. Nó kiểm **4 skill**. Khác shape của domain
    // payload cũng không tự nó là lỗi — cái cần chuẩn hoá là **status/decision**
    // (executed / pending_approval / denied), không phải ép mọi payload domain
    // về một cấu trúc.
  });

  /**
   * ── R16/R17 — soát ngữ nghĩa 48 mutation chưa map ──────────────────────────
   *
   * Đây là mảnh audit cuối mà review xác nhận làm được trong grant hiện tại:
   * biến "49 candidate chưa khớp tên" thành phân loại có căn cứ, thay vì suy từ
   * tên ra "không có skill" (đúng lỗi logic đã bị bắt ở vòng 6).
   *
   * Con số đổi từ **49 → 48** vì `compile_intent` bị phân loại sai: nó gọi LLM và
   * `IntentService.compile` ghi rõ *"Returns the compiled draft for the user to
   * confirm — never persists"*, nên nó là **provider-cost preview**, không phải
   * mutation. Cùng lớp với `translate_text` ⇒ nhóm provider action: 1 → 2.
   */
  it('R16: không tool nào trong 48 mutation chưa map có skill tương đương theo token-set', () => {
    const tokens = (s: string) =>
      s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join('|');

    /** 48 mutation chưa map, nhóm theo prefix REST thật (đo bằng listTools + gọi handler). */
    const UNMAPPED_MUTATIONS = [
      // privilege-affecting (22)
      'assign_role_user', 'remove_role_user', 'attach_role_policy', 'detach_role_policy', 'update_role',
      'add_policy_permission', 'update_policy_permission', 'delete_policy_permission',
      'attach_policy_user', 'detach_policy_user', 'update_policy',
      'attach_api_key_role', 'detach_api_key_role', 'attach_api_key_policy', 'detach_api_key_policy',
      'create_share', 'revoke_share',
      'apply_access_import', 'restore_backup',
      'approve_content', 'reject_content', 'submit_review',
      // content/schema/ops (26)
      'apply_schema', 'update_collection', 'upsert_field',
      'create_release', 'update_release', 'delete_release', 'publish_release',
      'register_materialization', 'refresh_materialization', 'drop_materialization',
      'delete_media',
      'upsert_tm', 'update_tm', 'delete_tm',
      'update_cdc_subscription', 'update_flow', 'update_team',
      'pause_intent', 'resume_intent', 'scan_intent', 'update_intent',
      'create_preset', 'update_preset', 'delete_preset',
      'install_marketplace_extension', 'publish_extension',
    ];
    expect(UNMAPPED_MUTATIONS).toHaveLength(48);
    expect(new Set(UNMAPPED_MUTATIONS).size).toBe(48);

    // Không tên nào khớp token-set với một skill thật ⇒ không có alias thuần.
    const skillTokens = new Map(Object.keys(CORE_SKILLS).map((s) => [tokens(s), s]));
    const accidental: string[] = [];
    for (const tool of UNMAPPED_MUTATIONS) {
      const hit = skillTokens.get(tokens(tool));
      if (hit) accidental.push(`${tool} → ${hit}`);
    }
    expect(accidental).toEqual([]);

    // Kiểm âm: thuật toán VẪN tìm được alias khi có thật (ca đã biết).
    expect(skillTokens.get(tokens('cdc_subscription_replay'))).toBe('replayCdcSubscription');

    // ── PHẠM VI (rút kinh nghiệm vòng 6) ───────────────────────────────────
    // Đây là bằng chứng "không có alias theo tên", KHÔNG phải "không thể có
    // skill tương đương". Kết luận support/disabled của từng tool nằm ở §5d của
    // PR, dựa trên đọc route + service, không dựa vào test này.
  });

  it('R17 [REGRESSION]: createField không còn rụng field âm thầm; field lạ bị từ chối', async () => {
    /**
     * Hai tool duy nhất mà tên gợi ý đã có skill phủ. Đo thật cho thấy không.
     */

    // ── Ca 1: upsert_field vs skill createField ────────────────────────────
    const captured: Array<[string, Record<string, unknown>]> = [];
    const schemaService = {
      createField: vi.fn((collection: string, input: Record<string, unknown>) => {
        captured.push([collection, input]);
        return Promise.resolve({ id: 'f1' });
      }),
    };
    const harness = new AISecureHarness({
      db: {} as Database,
      siteId: 'site_1',
      schemaService: schemaService as never,
      enableAgentHarnessAudit: false,
    });

    /**
     * LƯU Ý PHẠM VI (yêu cầu R3 của review vòng 8): đây là args **sau phép rename
     * giả định** `field_name → name`. stdio quảng bá `field_name`, còn ở đây tôi
     * đưa `name` vào skill — tức đã cho mapping một lợi thế. Ngay cả vậy,
     * projection vẫn rụng field.
     *
     * Và kết luận về **nhánh upsert** đến từ source, không phải từ việc
     * `updateField` không tồn tại: `PUT /collections/:c/fields/:f` dùng
     * `SchemaService.upsertField` (`routes/collections.ts:236`,
     * `schema-service.ts:538`) — update nếu có, create nếu chưa. Skill chỉ gọi
     * `createField`.
     */
    await harness.runSkill('createField', {
      collection: 'posts',
      name: 'body',
      type: 'text',
      required: true,
      interface: 'markdown',
      note: 'nội dung bài',
    });

    expect(captured).toHaveLength(1);
    const [, input] = captured[0]!;
    // TRƯỚC: handler hardcode `interface: 'input'` và chỉ đọc 4 arg, nên
    // `interface: 'markdown'` và `note` **rụng âm thầm** — caller xin editor
    // markdown mà nhận input một dòng, không có lỗi nào.
    // NAY: hai field đó thuộc contract đã quảng bá và được forward.
    expect(input['interface']).toBe('markdown');
    expect(input['note']).toBe('nội dung bài');
    expect(Object.keys(input).sort()).toEqual(['interface', 'name', 'note', 'required', 'type']);

    // Mặt còn lại của cùng một lớp lỗi: field **ngoài** contract không được
    // rụng im lặng, nó phải bị từ chối. `.strict()` ở
    // `packages/contracts/src/agent-tools/schemas.ts` là chỗ ép điều đó.
    const rejected = await harness.runSkill('createField', {
      collection: 'posts',
      name: 'body2',
      type: 'text',
      madeUpKnob: true,
    });
    expect(rejected.success).toBe(false);
    expect(rejected.success === false && rejected.code).toBe('VALIDATION');
    expect(rejected.success === false && rejected.error).toContain('madeUpKnob');
    // Không có lần gọi service thứ hai.
    expect(captured).toHaveLength(1);

    // ── PHẠM VI GIỮ NGUYÊN ──────────────────────────────────────────────────
    // Việc `upsert_field` của stdio **không** được phủ bởi `createField` vẫn
    // đúng và vẫn chưa đóng: `PUT /collections/:c/fields/:f` đi qua
    // `SchemaService.upsertField` (`routes/collections.ts:236`,
    // `schema-service.ts:538`) — update nếu có, create nếu chưa — còn skill chỉ
    // gọi `createField`. Không có `updateField`:
    expect(CORE_SKILLS['updateField']).toBeUndefined();
  });

  it('R19: bảng create/update/delete từng domain, đo từ CORE_SKILLS thật (sửa claim "11 tài nguyên")', () => {
    /**
     * Sửa theo yêu cầu **R2** của review vòng 8. Claim cũ — *"11 tài nguyên chỉ
     * có create+delete"* — **sai**: thiếu 11 tên `update*` không chứng minh cả 11
     * domain đều có cặp create/delete. Đo lại từng domain, ba thao tác.
     */
    const has = (n: string) => Boolean(CORE_SKILLS[n]);
    /** [domain, createSkill|null, updateSkill|null, deleteSkill|null] */
    const table: Array<[string, string | null, string | null, string | null]> = [
      // A. có create + delete, KHÔNG có update  → 8 domain
      ['collection', 'createCollection', null, 'deleteCollection'],
      ['field', 'createField', null, 'deleteField'],
      ['role', 'createRole', null, 'deleteRole'],
      ['policy', 'createPolicy', null, 'deletePolicy'],
      ['flow', 'createFlow', null, 'deleteFlow'],
      ['intent', 'createIntent', null, 'deleteIntent'],
      ['team', 'createTeam', null, 'deleteTeam'],
      ['cdcSubscription', 'createCdcSubscription', null, 'deleteCdcSubscription'],
      // B. thiếu CẢ BA thao tác → 3 domain
      ['release', null, null, null],
      ['preset', null, null, null],
      ['translationMemory (tm)', null, null, null],
    ];

    for (const [domain, c, u, d] of table) {
      if (c) expect(has(c), `${domain}: ${c} tồn tại`).toBe(true);
      if (d) expect(has(d), `${domain}: ${d} tồn tại`).toBe(true);
      // update luôn absent trong bảng này
      expect(u).toBeNull();
      for (const cand of [`update${domain[0]!.toUpperCase()}${domain.slice(1)}`]) {
        expect(CORE_SKILLS[cand], `${cand} phải absent`).toBeUndefined();
      }
    }

    // Nhóm A: 8 domain có cặp create/delete
    expect(table.filter(([, c, , d]) => c !== null && d !== null)).toHaveLength(8);
    // Nhóm B: 3 domain absent cả ba
    expect(table.filter(([, c, u, d]) => c === null && u === null && d === null)).toHaveLength(3);
    // release/preset/tm: absent cả ba, kiểm trực tiếp
    for (const n of ['createRelease', 'updateRelease', 'deleteRelease',
                     'createPreset', 'updatePreset', 'deletePreset']) {
      expect(CORE_SKILLS[n], `${n} absent`).toBeUndefined();
    }

    // NGỮ CẢNH, không dùng để phủ domain khác: registry CÓ 7 skill update/upsert
    // cho các domain khác.
    const updateish = Object.keys(CORE_SKILLS).filter((n) => /^(update|upsert)/.test(n)).sort();
    expect(updateish).toEqual([
      'updateExtension', 'updateItem', 'updateTranslation', 'updateUser',
      'updateVersion', 'updateWebhook', 'upsertSetting',
    ]);

    // Và sửa nốt một con số sai: trong 11 tool update-ish chưa map, **9** thuộc
    // nhóm C còn **2** (`update_role`, `update_policy`) thuộc nhóm P — nên câu
    // "11 trong 26 nhóm C" của bản trước là sai.
    const UPDATEISH_UNMAPPED_P = ['update_role', 'update_policy'];
    const UPDATEISH_UNMAPPED_C = [
      'update_collection', 'update_flow', 'update_intent', 'update_team',
      'update_cdc_subscription', 'update_release', 'update_preset', 'update_tm', 'upsert_field',
    ];
    expect(UPDATEISH_UNMAPPED_P).toHaveLength(2);
    expect(UPDATEISH_UNMAPPED_C).toHaveLength(9);

    // KHÔNG đề xuất delete+recreate làm workaround cho update (yêu cầu R2).
  });

  it('R18: thay marketplace install bằng generic registration làm MẤT gate/default/provenance (probe cặp)', async () => {
    /**
     * Sửa theo yêu cầu **R1** của review vòng 8.
     *
     * Bản trước gọi đây là "bỏ qua verify chữ ký" nhưng chỉ assert sự tồn tại +
     * description của skill ⇒ **không phải bằng chứng đo được**. Reviewer đã đọc
     * đủ hai đường và xác nhận rủi ro là **có căn cứ nhưng có điều kiện**:
     *
     *   `routes/marketplace.ts:543-622` — kiểm `extensions:install`, resolve slug
     *   thành listing global đã publish, gọi `ExtensionVerifierService
     *   .verifyByMetadata`, chặn khi `requireSignature && !verdict.ok`, chặn
     *   reserved `lumibase-*` không có official signature, rồi mới insert; đồng
     *   thời bảo toàn signature/provenance/marketplaceSlug, derive
     *   `isOfficial`/`verifiedAt` **ở server**, dùng `enabledByDefault`, khởi tạo
     *   `capabilities: []`.
     *
     *   `ai-harness.ts:1740` → `extensions-service.ts:42` — generic registration
     *   nhận metadata **do caller cấp** và insert; **không** marketplace lookup,
     *   **không** verifier, và cho caller cấp `capabilities`.
     *
     * PHÁT BIỂU ĐÚNG (không phải "bypass đã thành công"): *nếu* một adapter
     * resolve đủ metadata rồi thay marketplace install bằng generic registration
     * thì **mất** các check/default/provenance đó. Bản thân slug-only sẽ **fail**
     * vì thiếu tham số bắt buộc, nên đây **không** phải bypass chạy được, và
     * **không** suy ra "đã chạy được unsigned code" — kiểm crypto là việc riêng.
     *
     * Probe dưới đây đo **nửa generic registration**: metadata đầy đủ do caller
     * cấp thì insert **không** đi qua verifier nào. Nửa marketplace (invalid
     * verdict ⇒ reject + zero insert) thuộc route marketplace, ngoài hai file
     * repro được cấp, nên ghi là source-backed thay vì tự mở scope.
     */
    /**
     * SỬA THEO F1. Bản trước gắn `verifyByMetadata` vào một **object giả** rồi
     * assert bộ đếm bằng 0 — nhưng verifier thật là `ExtensionVerifierService`,
     * một class khác, và `ExtensionsService` thật KHÔNG hề có method đó. Nên
     * assertion ấy là **tautology**: nó đúng bất kể production làm gì. Kiểm âm
     * đã chứng minh — thêm verification + ép provenance vào
     * `ExtensionsService.installExtension` thật, test vẫn XANH.
     *
     * Bản này đo đường thật:
     *   - `ExtensionsService` **thật** (không mock), trên db recorder;
     *   - spy vào `ExtensionVerifierService.prototype.verifyByMetadata` — verifier
     *     **thật** — nên nếu service thật bắt đầu verify thì spy sẽ bắt được;
     *   - đọc giá trị **thực sự đi vào `db.insert().values()`**, không phải args
     *     mà caller truyền.
     *
     * Nhờ đó: thêm verifier vào đường generic ⇒ đỏ ở bộ đếm; ép
     * `capabilities: []` ⇒ đỏ; derive `isOfficial`/`verifiedAt` server-side ⇒ đỏ.
     */
    const verifierSpy = vi.spyOn(ExtensionVerifierService.prototype, 'verifyByMetadata');

    const inserts: Array<{ table: string; values: Record<string, unknown> }> = [];
    const db = {
      insert: (t: unknown) => {
        const table = getTableName(t as Parameters<typeof getTableName>[0]);
        return {
          values: (values: Record<string, unknown>) => {
            inserts.push({ table, values });
            const result = [{ id: 'ext_1', ...values }];
            return {
              returning: () => Promise.resolve(result),
              then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(result).then(resolve),
            };
          },
        };
      },
    } as unknown as Database;

    // Service THẬT — đây là điểm khác cốt lõi so với bản trước.
    const extensionsService = new ExtensionsService({ db, siteId: 'site_1', userId: 'user_1' });
    const harness = new AISecureHarness({
      db,
      siteId: 'site_1',
      extensionsService,
      enableAgentHarnessAudit: false,
    });

    // Caller tự cấp TOÀN BỘ metadata, gồm cả `capabilities` — thứ mà đường
    // marketplace luôn khởi tạo `[]` ở server.
    const outcome = await harness.runSkill('installExtension', {
      key: 'evil-panel',
      name: 'evil-panel',
      version: '1.0.0',
      type: 'panel',
      enabled: true,
      bundleUrl: 'https://attacker.example/bundle.js',
      manifest: { entry: 'index.js' },
      capabilities: ['items:write', 'schema:write'],
    });

    expect(outcome.success).toBe(true);

    // Hàng THẬT mà service thật ghi xuống `extensions`.
    const extRows = inserts.filter((i) => i.table === getTableName(extensions));
    expect(extRows, 'service thật phải insert đúng 1 hàng extensions').toHaveLength(1);
    const row = extRows[0]!.values;

    // ĐO ĐƯỢC 1: verifier THẬT không được gọi ở đâu trên đường generic.
    expect(verifierSpy).not.toHaveBeenCalled();
    expect(verifierSpy.mock.calls).toHaveLength(0);

    // ĐO ĐƯỢC 2: capabilities do CALLER quyết định — server KHÔNG ép `[]`.
    expect(row['capabilities']).toEqual(['items:write', 'schema:write']);

    // ĐO ĐƯỢC 3: không trường provenance nào của marketplace được dựng, nên
    // trust không thể derive ở server như đường marketplace làm.
    for (const field of ['marketplaceSlug', 'verifiedAt', 'isOfficial', 'signature', 'publisherKeyId']) {
      expect(row[field], `${field} không được dựng ở đường generic`).toBeUndefined();
    }

    verifierSpy.mockRestore();

    // Điều kiện enable (ghi vào §5d): adapter phải bảo toàn signature policy,
    // reserved namespace, server-derived trust, permission và provenance —
    // không phải chỉ đổi tên tham số `slug` ↔ `bundleUrl`.
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

  it('RT1 [REGRESSION]: tools/list qua route thật quảng bá schema đã khai [end-to-end]', async () => {
    const { db } = governedDb();
    const { body, status } = await rpc(buildApp(ADMIN, db), 'tools/list');

    expect(status).toBe(200);
    const tools = (body.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools.length).toBeGreaterThan(50);

    // Cùng claim với `R1` nhưng qua route thật — đây là thứ MCP client nhận
    // được. Mọi skill đã khai schema phải thấy đúng schema đó, kèm `properties`.
    const declaring = Object.entries(CORE_SKILLS).filter(([, s]) => s.inputSchema !== undefined);
    expect(declaring.length).toBeGreaterThan(0);
    for (const [name, skill] of declaring) {
      const advertised = tools.find((t) => t.name === name);
      expect(advertised, `${name} có trong tools/list`).toBeDefined();
      expect(advertised!.inputSchema, `${name} quảng bá schema đã khai`).toEqual(skill.inputSchema);
    }
    expect(tools.some((t) => t.inputSchema['properties'] !== undefined)).toBe(true);
  });

  it('RT2 [REGRESSION]: tools/list is usable and `{}` is refused with a structured VALIDATION denial', async () => {
    const { db, inserts } = governedDb();
    const app = buildApp(ADMIN, db);

    // Step 1: discover, exactly as a client would.
    const listed = await rpc(app, 'tools/list');
    const tools = (listed.body.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    const createItem = tools.find((t) => t.name === 'createItem');
    expect(createItem).toBeDefined();

    // Step 2: BEFORE, the advertised contract was `{type:'object'}` — `{}`
    // satisfied it, so a well-behaved client had no way to learn that
    // `collection` is required. NOW the schema is derived from the canonical Zod
    // contract, so the requirement is discoverable.
    expect(createItem!.inputSchema['required']).toEqual(['collection', 'data']);
    expect(Object.keys(createItem!.inputSchema['properties'] as object).sort()).toEqual([
      'collection',
      'data',
      'status',
    ]);
    expect(createItem!.inputSchema['additionalProperties']).toBe(false);

    // Step 3: send `{}` anyway. BEFORE it was dispatched and failed deep inside
    // the real ItemService, surfacing to the client as a raw engine error:
    //
    //   {"status":"denied","runId":"…",
    //    "message":"Cannot read properties of undefined (reading 'length')"}
    //
    // NOW it is refused at the boundary with a message that names the fields.
    const called = await rpc(app, 'tools/call', { name: 'createItem', arguments: {} });
    expect(called.status).toBe(200);

    const result = called.body.result as {
      structuredContent: { status: string; code?: string; message?: string; runId?: string };
      isError?: boolean;
    };
    const decision = result.structuredContent;
    expect(decision.status).toBe('denied');
    expect(decision.code).toBe('VALIDATION');
    expect(decision.message).toContain('collection');
    expect(decision.message).toContain('data');
    // The engine error must not come back.
    expect(JSON.stringify(called.body)).not.toMatch(/Cannot read properties of undefined/);
    // A refused input is an error tool result, not a JSON-RPC protocol error:
    // `mcp-service.ts` already maps `status === 'denied'` to `isError`, and
    // keeping business outcomes inside the result is the existing contract
    // (Req 4.4). That is why -32602 is deliberately NOT used here.
    expect(result.isError).toBe(true);
    expect(JSON.stringify(called.body)).not.toMatch(/-32602/);

    // And nothing was persisted for it — no run, no tool call.
    expect(inserts).toHaveLength(0);
    expect(decision.runId).toBeUndefined();
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

  it('R12 [REGRESSION]: REST chỉ nhận body có envelope data; body top-level bị 400', async () => {
    const { app, created } = await buildItemsApp();

    // Body mà `packages/mcp-server/src/tools/items.ts` phát ra TRƯỚC khi sửa:
    //   client.post(`/items/${collection}`, { ...itemData, status })
    // tức field của item bị spread ra TOP LEVEL, không bọc trong `data`.
    // Giữ lại làm hàng rào: nó phải TIẾP TỤC bị REST từ chối, để không ai quay
    // về dạng body cũ. Body đúng (đã sửa ở stdio) là control ở cuối test.
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

  it('R13 [REGRESSION]: patch có envelope data tới được service; bare body là no-op', async () => {
    const { app, patched } = await buildItemsApp();

    // Body thật: `client.patch(path, itemData)` — gửi thẳng field, không envelope.
    const res = await app.request('/api/v1/items/posts/item_1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new title' }),
    });

    // Body TRƯỚC khi sửa. Giữ lại làm hàng rào: `patchSchema` có mọi field
    // optional và Zod **strip** key lạ, nên `title` bị loại âm thầm và kết quả là
    // **200 OK với patch rỗng**. Body đúng (đã sửa ở stdio) là control ở cuối.
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
