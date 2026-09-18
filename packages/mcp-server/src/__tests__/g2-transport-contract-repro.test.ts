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

/**
 * Registry dùng CHUNG, dựng đúng MỘT lần cho cả file.
 *
 * Vì sao: `registerAllTools` đăng ký ~161 tool kèm dựng Zod schema, nên gọi nó
 * nhiều lần trong một test là đắt. `S7` từng gọi `registryOnly()` **8 lần** và
 * reviewer đo được **5179ms** so với `testTimeout` mặc định **5000ms** của
 * package này (không có `vitest.config`), nên nó fail lần đầu rồi pass lần chạy
 * lại. Đó là chi phí đăng ký, không phải hành vi cần kiểm — nên cách sửa là
 * dựng một lần, KHÔNG nới timeout.
 *
 * Handler là closure trên client giả và không giữ trạng thái riêng, nên dùng lại
 * an toàn; cô lập giữa các lần gọi bằng cách xoá recorder.
 */
const shared = registryOnly();

/**
 * Gọi một tool trên registry chung và trả về CHỈ các REST call của lần gọi đó.
 * Thay cho việc dựng lại cả registry mỗi lần.
 */
async function callToolIsolated(
  name: string,
  args: Record<string, unknown>,
): Promise<Array<{ method: string; path: string; body?: unknown }>> {
  const entry = shared.tools.get(name);
  expect(entry, `${name} có trong registry`).toBeDefined();
  shared.calls.length = 0;
  await entry!.handler(args);
  return [...shared.calls];
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

    /** Runs one tool on the shared registry and returns the REST path it targeted. */
    async function restTargetOf(name: string, args: Record<string, unknown>): Promise<string> {
      const calls = await callToolIsolated(name, args);
      expect(calls.length, `${name} issued exactly one REST call`).toBe(1);
      return calls[0]!.path;
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

describe('G2 repro · body envelope: stdio gửi field ra top level, không bọc data', () => {
  /**
   * Nửa stdio của repro envelope (review vòng 3, P1). Nửa CMS là `R12`/`R13`
   * trong `apps/cms/.../g2-mcp-contract-repro.test.ts`, nhận đúng hai body dưới
   * đây rồi cho chạy qua `itemsRouter` thật: `create` → **400**,
   * `patch` → **200 nhưng patch rỗng**.
   *
   * Tách hai nửa vì hai package **không phụ thuộc nhau**; nối trực tiếp sẽ cần
   * đổi manifest, vượt grant bước 1. Bài học phương pháp: bảng mapping ở các
   * head trước so "schema quảng bá" với "args skill đọc" nên **không thể** thấy
   * lớp lỗi này — phải so cả **body thật sự gửi đi**.
   */
  it('S6: create_item spread field ra top level; update_item gửi bare — cả hai thiếu envelope data', async () => {
    const { tools, calls } = registryOnly();

    await tools.get('create_item')!.handler({
      collection: 'posts',
      data: { title: 'x' },
      status: 'draft',
    });
    await tools.get('update_item')!.handler({
      collection: 'posts',
      id: 'item_1',
      data: { title: 'new title' },
    });

    expect(calls).toHaveLength(2);

    // CURRENT: `client.post(path, { ...itemData, status })` — `title` nằm ở TOP
    // LEVEL, không có key `data`. REST `createSchema` đòi `data: record` ⇒ 400.
    expect(calls[0]!.path).toBe('/items/posts');
    expect(calls[0]!.body).toEqual({ title: 'x', status: 'draft' });
    expect(Object.keys(calls[0]!.body as object)).not.toContain('data');

    // CURRENT: `client.patch(path, itemData)` — gửi bare. REST `patchSchema`
    // strip key lạ ⇒ service nhận `{}`, nhưng response vẫn 200.
    expect(calls[1]!.path).toBe('/items/posts/item_1');
    expect(calls[1]!.body).toEqual({ title: 'new title' });
    expect(Object.keys(calls[1]!.body as object)).not.toContain('data');

    // EXPECTED cho cả hai: `{ data: { title: … }, status? }`.
  });
});

describe('G2 repro · inventory có phân loại ngữ nghĩa (review vòng 3, P2)', () => {
  /**
   * Head trước báo `98 write / 40 mapped / 58 unmapped`. Review vòng 3 đúng ở hai
   * điểm và test này khoá lại cả hai:
   *
   * 1. **98 là số handler dùng method khác GET, KHÔNG phải 98 mutation.** Có 7
   *    tool dùng POST nhưng ngữ nghĩa là đọc/preview, cộng 1 tool là hành động
   *    tốn phí provider (`translate_text`) cần lớp riêng.
   * 2. **"Không khớp tên" ≠ "không có skill".** `cdc_subscription_replay` đã có
   *    skill `replayCdcSubscription`, chỉ khác thứ tự từ trong alias.
   *
   * Đối chiếu alias bằng **token-set** (chuẩn hoá rồi sort token) thay vì
   * camelCase thuần — chính chỗ head trước bỏ lọt.
   */

  /** Chuẩn hoá tên thành tập token đã sort, để so alias bất kể thứ tự từ. */
  const tokens = (s: string) =>
    s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join('|');

  /** POST/PATCH nhưng ngữ nghĩa đọc/preview — KHÔNG được disable chỉ vì method. */
  const READ_VIA_POST = [
    'check_permission',
    'check_access_conflicts',
    'dry_run_access_import',
    'diff_schema',
    'lookup_tm',
    'query_insights',
    'run_panel',
  ];

  /** Hành động có chi phí/provider ngoài — lớp riêng, không phải content mutation. */
  const PROVIDER_ACTION = ['translate_text'];

  /**
   * S7 — **PHẠM VI BẰNG CHỨNG** (sửa theo review vòng 4).
   *
   * Bản trước chỉ assert 8 tên tồn tại và độ dài hai mảng literal, nên đổi
   * handler của một tool đọc thành write vẫn **không** làm nó đỏ. Đó là
   * inventory example, không phải hàng rào.
   *
   * Bản này **gọi handler thật** và khoá **REST target** (method + path) của
   * từng tool. Nhờ đó đổi endpoint hay method của bất kỳ tool nào trong nhóm sẽ
   * làm test đỏ.
   *
   * Điều test này **KHÔNG** chứng minh: rằng các route đó là read theo ngữ nghĩa.
   * Phán đoán đó đến từ đọc code CMS (`routes/permissions.ts`, `routes/access.ts`,
   * `routes/collections.ts`, `routes/translation-memory.ts`, `routes/insights.ts`,
   * `services/insights-service.ts`) — không phải từ đây. Test chỉ khoá **đầu vào**
   * của phán đoán để nó không trôi âm thầm.
   */
  it('S7: khoá REST target của 7 tool đọc-qua-POST + 1 provider action (không phải bằng chứng ngữ nghĩa)', async () => {
    const expected: Record<string, string> = {
      check_permission: 'POST /permissions/check',
      check_access_conflicts: 'POST /access/conflicts/check',
      dry_run_access_import: 'POST /access/import?dryRun=true',
      diff_schema: 'POST /collections/diff',
      lookup_tm: 'POST /tm/lookup',
      // Cả hai đi qua `/dashboards/...`; `query_insights` là ad-hoc preview
      // (mô tả tool tự ghi "Read-only"), `run_panel` chạy panel đã lưu.
      query_insights: 'POST /dashboards/d1/panels/preview',
      run_panel: 'POST /dashboards/d1/panels/p1/data',
      translate_text: 'POST /tm/translate',
    };
    const args: Record<string, Record<string, unknown>> = {
      check_permission: { collection: 'posts', action: 'read' },
      check_access_conflicts: {},
      dry_run_access_import: { payload: {} },
      diff_schema: { collections: [] },
      lookup_tm: { source: 'hello', sourceLanguage: 'en', targetLanguage: 'vi' },
      query_insights: { dashboardId: 'd1', collection: 'posts', aggregate: 'count' },
      run_panel: { dashboardId: 'd1', panelId: 'p1' },
      translate_text: { text: 'hello', targetLanguage: 'vi' },
    };

    const observed: Record<string, string> = {};
    for (const name of [...READ_VIA_POST, ...PROVIDER_ACTION]) {
      const calls = await callToolIsolated(name, args[name] ?? {});
      expect(calls.length, `${name} phát đúng 1 REST call`).toBe(1);
      observed[name] = `${calls[0]!.method} ${calls[0]!.path}`;
    }

    // Khoá từng target một, không chỉ đếm mảng.
    expect(observed).toEqual(expected);

    // Và đây là lý do "98" không phải số mutation: cả 8 tool đều dùng POST,
    // nên bộ đếm theo HTTP method xếp chúng vào write.
    expect(Object.values(observed).every((v) => v.startsWith('POST '))).toBe(true);
  });

  /**
   * S8 — **PHẠM VI BẰNG CHỨNG** (sửa theo review vòng 4).
   *
   * Bản trước chỉ chuẩn hoá **chuỗi literal**, nên xoá/đổi tên
   * `replayCdcSubscription` phía CMS vẫn **không** làm nó đỏ. Bản này giới hạn
   * claim đúng phạm vi: token-set là **thuật toán tìm CANDIDATE**, không phải
   * bằng chứng skill tồn tại hay tương đương ngữ nghĩa.
   *
   * Phần "skill có thật trong `CORE_SKILLS`" được assert ở **`R14`** phía CMS —
   * nơi import được registry thật. `packages/mcp-server` không phụ thuộc
   * `apps/cms` nên không thể kiểm ở đây mà không đổi manifest.
   */
  it('S8: token-set tìm CANDIDATE alias mà camelCase bỏ lọt (không phải bằng chứng skill tồn tại)', () => {
    // camelCase thuần: cdc_subscription_replay -> cdcSubscriptionReplay.
    const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
    expect(camel('cdc_subscription_replay')).toBe('cdcSubscriptionReplay');

    // token-set coi hai tên này là cùng một tập token ⇒ candidate.
    expect(tokens('cdc_subscription_replay')).toBe(tokens('replayCdcSubscription'));
    // …nhưng camelCase thuần thì không, nên phương pháp cũ bỏ lọt.
    expect(camel('cdc_subscription_replay')).not.toBe('replayCdcSubscription');

    // Kiểm âm: token-set không biến mọi thứ thành candidate.
    expect(tokens('create_release')).not.toBe(tokens('createCollection'));
    expect(tokens('update_collection')).not.toBe(tokens('createCollection'));

    // Ghi rõ giới hạn suy luận: "không trùng token" KHÔNG kết luận được
    // "không có skill tương đương" — nó chỉ nói thuật toán này không tìm ra
    // candidate. Kết luận cuối cần soát ngữ nghĩa từng tool (Quyết định 1).
  });

  it('S9: create_collection advertise 18 property và 32 tool toàn registry có confirm', async () => {
    const { client } = await liveClient();
    const listed = await client.listTools();

    // Sửa số của head trước (19 property / thiếu 17): đo lại đúng là 18, và
    // skill chỉ đọc `name` + `singleton` ⇒ thiếu **16**.
    const cc = listed.tools.find((t) => t.name === 'create_collection');
    const props = Object.keys((cc!.inputSchema as { properties: Record<string, unknown> }).properties);
    expect(props).toHaveLength(18);
    expect(props).toContain('name');
    expect(props).toContain('singleton');

    // `confirm` đếm trên TOÀN registry là 32 — head trước ghi "~20" mà không nêu
    // mẫu đếm, nên ghi rõ mẫu ở đây.
    const withConfirm = listed.tools.filter((t) => {
      const s = t.inputSchema as { properties?: Record<string, unknown> };
      return Boolean(s.properties && Object.hasOwn(s.properties, 'confirm'));
    });
    expect(withConfirm).toHaveLength(32);
  });
});

describe('G2 repro · result-shape probes: forwarding and wrapper behaviour', () => {
  /**
   * Khoảng trống còn lại của bảng mapping, review vòng 3 đã chỉ:
   * *"result createCollection là `{created:true,collection:row}` ở skill nhưng
   * stdio trả row; adapter phải xử lý rõ executed/pending/denied, không coi
   * pending là thành công mutation."*
   *
   * Các probe dưới đây đo những hành vi cụ thể; chúng không suy rộng kết quả
   * sang toàn bộ candidate mapping.
   */

  it('S10: fault injection — delete tool ignores a fulfilled decision-shaped value', async () => {
    const tools = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      registerTool: (n: string, _c: unknown, h: (a: Record<string, unknown>) => Promise<unknown>) => tools.set(n, h),
    };

    /**
     * ── LOẠI BẰNG CHỨNG: fault-injection probe cho RỦI RO MIGRATION ─────────
     * (phân loại lại theo review vòng 6)
     *
     * Giá trị dưới đây dùng đúng field của `McpToolDecision`, nhưng KHÔNG phải
     * nguyên response governed hiện tại. Cụ thể:
     *   - MCP bọc decision trong `content` / `structuredContent` / `isError`,
     *     rồi JSON-RPC bọc thêm một lớp `result`;
     *   - `DELETE /collections/:name` hiện trả **204** sau khi đã thực thi.
     *
     * Vì vậy test này **KHÔNG** tái hiện "CMS live park → stdio báo deleted".
     * Nó chứng minh một điều hẹp hơn nhưng vẫn đáng giá: handler **bỏ qua hoàn
     * toàn** giá trị fulfilled của client và tự dựng câu khẳng định — nên NẾU
     * một adapter tương lai đưa decision (kể cả pending) vào đúng đường này thì
     * người dùng sẽ bị báo sai. Đó là rủi ro của bước migration, không phải lỗi
     * production đang xảy ra.
     */
    const injectedDecision = { status: 'pending_approval', approvalId: 'apr_1' } as const;
    const cms = {
      get: vi.fn(() => Promise.resolve(injectedDecision)),
      post: vi.fn(() => Promise.resolve(injectedDecision)),
      patch: vi.fn(() => Promise.resolve(injectedDecision)),
      put: vi.fn(() => Promise.resolve(injectedDecision)),
      delete: vi.fn(() => Promise.resolve(injectedDecision)),
      getText: vi.fn(() => Promise.resolve('x')),
      getRootText: vi.fn(() => Promise.resolve('x')),
      postRaw: vi.fn(() => Promise.resolve(injectedDecision)),
    };
    registerAllTools(server as never, cms as unknown as LumiBaseClient);

    const result = (await tools.get('delete_collection')!({ name: 'posts', confirm: true })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    const text = result.content[0]!.text;

    // CURRENT: handler làm `await client.delete(...)` rồi **tự** dựng câu khẳng
    // định, không hề đọc giá trị fulfilled. Nên bất kể client trả gì — kể cả một
    // decision nói rõ chưa thực thi — MCP client vẫn nhận
    // "Collection "posts" deleted." với `isError` falsy.
    // EXPECTED: result phải phản ánh executed / pending_approval / denied, và
    // pending KHÔNG được trình bày như mutation đã hoàn tất.
    expect(text).toContain('deleted');
    expect(text).not.toContain('pending');
    expect(text).not.toContain('apr_1');
    expect(result.isError ?? false).toBe(false);

    // Cùng lớp lỗi với các delete tool khác — không phải ca lẻ.
    for (const [name, args] of [
      ['delete_item', { collection: 'posts', id: 'i1', confirm: true }],
      ['delete_role', { id: 'r1', confirm: true }],
      ['delete_field', { collection: 'posts', field_name: 'title', confirm: true }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = (await tools.get(name)!(args)) as { content: Array<{ text: string }> };
      expect(r.content[0]!.text, `${name} tự khẳng định đã xoá`).toMatch(/deleted/i);
      expect(r.content[0]!.text, `${name} không nêu pending`).not.toMatch(/pending/i);
    }
  });

  it('S11: alias cdc_subscription_replay lệch tên key và có `cursor` không đối ứng', async () => {
    const { client } = await liveClient();
    const listed = await client.listTools();
    const replay = listed.tools.find((t) => t.name === 'cdc_subscription_replay');
    const props = Object.keys((replay!.inputSchema as { properties: Record<string, unknown> }).properties);

    // stdio quảng bá snake_case + `cursor`.
    expect(props.sort()).toEqual(['cursor', 'occurred_after', 'subscription_id']);

    // Skill `replayCdcSubscription` đọc `subscriptionId` / `occurredAfter` và
    // KHÔNG đọc `cursor` (xem `ai-harness.ts`), nên alias này cần:
    //   1. đổi tên 2 key: subscription_id → subscriptionId,
    //      occurred_after → occurredAfter;
    //   2. quyết định số phận `cursor` — hiện không có đường vào skill;
    //   3. xử lý default: skill làm `String(args['occurredAfter'] ?? '')` nên
    //      thiếu giá trị sẽ thành chuỗi rỗng chứ không phải "không truyền".
    // Đây là lý do "có alias" chưa đồng nghĩa "map được ngay".
    expect(props).toContain('cursor');
    expect(props).not.toContain('subscriptionId');
    expect(props).not.toContain('occurredAfter');
  });
});

describe('G2 repro · soát ngữ nghĩa: compile_intent bị xếp sai nhóm', () => {
  /**
   * Phát hiện khi soát ngữ nghĩa 49 mutation chưa map (mảnh audit cuối).
   *
   * `compile_intent` dùng POST nên bộ đếm theo HTTP method xếp nó vào mutation.
   * Nhưng `IntentService.compile` ghi rõ trong docstring: *"Returns the compiled
   * draft for the user to confirm — **never persists**"*, và nó gọi
   * `this.deps.llm.provider.chat(...)`. Vậy nó là **provider-cost preview**,
   * cùng lớp với `translate_text`, không phải mutation.
   *
   * Hệ quả cho các con số: mutation **90 → 89**, mutation chưa map **49 → 48**,
   * provider action **1 → 2**.
   */
  it('S12: khoá REST target của compile_intent — tách khỏi đường tạo intent', async () => {
    const calls = await callToolIsolated('compile_intent', {
      description: 'bài viết phải có ảnh bìa',
      collection: 'posts',
    });

    // Nó POST tới endpoint compile — không tạo/sửa intent nào.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/agent/intents/compile');

    // Phân biệt với đường thật sự tạo intent (registerCrud trên /agent/intents).
    const createCalls = await callToolIsolated('create_intent', {
      name: 'i1',
      collection: 'posts',
      rules: [],
      schedule: '* * * * *',
    });
    expect(createCalls[0]!.path).toBe('/agent/intents');
    expect(createCalls[0]!.path).not.toBe(calls[0]!.path);

    // ── PHẠM VI (siết theo yêu cầu R4 của review vòng 8) ────────────────────
    // Test này CHỈ khoá REST target và cho thấy hai đường khác nhau.
    //
    // Kết luận "không persist" đến từ đọc phía CMS (`routes/intents.ts:182` +
    // toàn bộ `IntentService.compile` tại `intent-service.ts:205`: provider.chat
    // → parse/validate rules + schedule → trả draft; không có DB mutation, không
    // create/update/activate intent), **không** từ test này.
    //
    // Và KHÔNG phát biểu "không có bất kỳ side effect nào": vẫn có request ra
    // provider kèm chi phí, cộng middleware toàn cục không được test end-to-end ở
    // đây. Ngoài ra route giữ nguyên guard `canWriteIntents`
    // (`admin` | `intents:write` | `*`) — phân loại "preview" **không** hạ nó
    // xuống quyền read.
  });

  it('S13: phân loại phải PHỦ ĐÚNG registry thật — membership, uniqueness, disjointness, union', async () => {
    /**
     * Viết lại theo yêu cầu **R3** của review vòng 8. Bản trước chỉ **cộng hằng
     * số** nên vẫn xanh dù registry thêm/bớt/đổi tên tool — đúng là không khoá gì.
     *
     * Bản này gắn từng tập tên vào `listTools()` **thật**:
     *   - membership: mọi tên trong tập phải TỒN TẠI trong registry;
     *   - uniqueness: không trùng trong cùng tập;
     *   - disjointness: **năm** tập không giao nhau;
     *   - union **hai chiều**: registry ⊆ ∪tập và ∪tập ⊆ registry.
     *
     * SỬA THEO F2: bản trước chỉ khai báo 4 tập (98 tên) rồi lấy 63 tool còn lại
     * TRỰC TIẾP từ registry và chỉ kiểm số lượng + prefix. Hệ quả: đổi tên một
     * tool **trong nhóm 63** vẫn XANH — kiểm âm `get_release` → `get_release_v2`
     * đi lọt. Tức nó khoá danh tính 98/161, không phải toàn registry.
     *
     * Giờ `READ_GET_63` là tập khai báo tường minh, nên cả **161/161** tên đều
     * được khoá: đổi tên tool ở BẤT KỲ nhóm nào ⇒ membership/union đỏ; thêm/bớt
     * tool ⇒ union đỏ; xếp một tên vào hai nhóm ⇒ disjointness đỏ.
     */
    const { client } = await liveClient();
    const registry = (await client.listTools()).tools.map((t) => t.name);
    const registrySet = new Set(registry);

    /** 41 mutation candidate map được (40 theo tên + 1 alias). */
    const MAPPED_41 = [
      'create_item', 'update_item', 'delete_item',
      'create_collection', 'delete_collection', 'delete_field',
      'create_relation', 'delete_relation',
      'create_role', 'delete_role', 'create_policy', 'delete_policy',
      'create_flow', 'delete_flow', 'run_flow',
      'create_intent', 'delete_intent',
      'create_webhook', 'update_webhook', 'delete_webhook',
      'create_translation', 'update_translation', 'delete_translation',
      'upsert_setting', 'delete_setting',
      'create_cdc_subscription', 'delete_cdc_subscription', 'cdc_subscription_replay',
      'create_api_key', 'rotate_api_key', 'revoke_api_key',
      'invite_user', 'update_user', 'remove_user',
      'create_team', 'delete_team', 'add_team_member', 'remove_team_member',
      'install_extension', 'update_extension', 'uninstall_extension',
    ];
    /** 48 mutation chưa map (xem §5d của PR). */
    const UNMAPPED_48 = [
      'assign_role_user', 'remove_role_user', 'attach_role_policy', 'detach_role_policy', 'update_role',
      'add_policy_permission', 'update_policy_permission', 'delete_policy_permission',
      'attach_policy_user', 'detach_policy_user', 'update_policy',
      'attach_api_key_role', 'detach_api_key_role', 'attach_api_key_policy', 'detach_api_key_policy',
      'create_share', 'revoke_share',
      'apply_access_import', 'restore_backup',
      'approve_content', 'reject_content', 'submit_review',
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
    const PROVIDER_2 = ['translate_text', 'compile_intent'];
    /** 7 tool dùng POST nhưng ngữ nghĩa đọc/preview — REST target khoá ở `S7`. */
    const READ_VIA_POST_7 = [
      'check_permission', 'check_access_conflicts', 'dry_run_access_import',
      'diff_schema', 'lookup_tm', 'query_insights', 'run_panel',
    ];

    /**
     * 63 tool đọc-qua-GET. Khai báo TƯỜNG MINH theo yêu cầu F2: bản trước lấy
     * nhóm này trực tiếp từ registry rồi chỉ kiểm số lượng + prefix, nên đổi tên
     * một tool trong nhóm vẫn XANH (kiểm âm: `get_release` → `get_release_v2`).
     * Có tập tên rồi thì union so hai chiều và rename ở đây cũng đỏ.
     */
    const READ_GET_63 = [
      'list_collections', 'get_collection', 'list_fields', 'list_items', 'get_item',
      'list_relations', 'list_presets', 'get_preset', 'get_effective_preset',
      'list_preset_bookmarks', 'list_translations', 'get_translation', 'list_settings',
      'get_setting', 'search', 'list_media', 'list_transform_presets', 'list_tm',
      'list_dashboards', 'get_dashboard', 'list_dashboard_panels', 'list_reviews',
      'list_releases', 'get_release', 'get_my_permissions', 'list_roles', 'get_role',
      'list_policies', 'get_policy', 'export_access', 'list_api_keys', 'get_api_key',
      'list_users', 'get_user', 'list_teams', 'get_team', 'list_team_members',
      'list_webhooks', 'list_cdc_subscriptions', 'get_cdc_subscription', 'cdc_events_read',
      'list_intents', 'get_intent', 'list_intent_drifts', 'list_flows', 'get_flow',
      'list_flow_runs', 'get_flow_run', 'list_activity', 'get_site', 'get_health',
      'get_metrics', 'export_backup', 'list_materializations', 'query_materialization',
      'list_extensions', 'list_marketplace_extensions', 'get_marketplace_extension',
      'list_marketplace_updates', 'list_deployment_targets', 'list_deployments',
      'get_deployment', 'get_deployment_logs',
    ];

    const sets: Array<[string, string[]]> = [
      ['MAPPED_41', MAPPED_41],
      ['UNMAPPED_48', UNMAPPED_48],
      ['PROVIDER_2', PROVIDER_2],
      ['READ_VIA_POST_7', READ_VIA_POST_7],
      ['READ_GET_63', READ_GET_63],
    ];

    // 1) Kích thước khai báo
    expect(MAPPED_41).toHaveLength(41);
    expect(UNMAPPED_48).toHaveLength(48);
    expect(PROVIDER_2).toHaveLength(2);
    expect(READ_VIA_POST_7).toHaveLength(7);
    expect(READ_GET_63).toHaveLength(63);

    // 2) Uniqueness trong từng tập + membership trong registry THẬT
    for (const [label, list] of sets) {
      expect(new Set(list).size, `${label} không trùng nội bộ`).toBe(list.length);
      const missing = list.filter((n) => !registrySet.has(n));
      expect(missing, `${label}: mọi tên phải tồn tại trong registry`).toEqual([]);
    }

    // 3) Disjointness giữa bốn tập
    const seen = new Map<string, string>();
    const overlaps: string[] = [];
    for (const [label, list] of sets) {
      for (const n of list) {
        const prev = seen.get(n);
        if (prev) overlaps.push(`${n} ở cả ${prev} và ${label}`);
        else seen.set(n, label);
      }
    }
    expect(overlaps).toEqual([]);

    // 4) Union so HAI CHIỀU với registry thật (sửa theo F2).
    //    Trước đây nhóm 63 được lấy TỪ registry nên không khoá danh tính; giờ nó
    //    là tập khai báo, nên cả 161 tên đều có tập sở hữu.
    const classified = new Set(seen.keys());
    expect(classified.size).toBe(41 + 48 + 2 + 7 + 63);

    // 4a) registry ⊆ các tập: không tool nào của registry bị bỏ rơi.
    const unclassified = registry.filter((n) => !classified.has(n));
    expect(unclassified, 'mọi tool trong registry phải thuộc đúng một tập').toEqual([]);

    // 4b) các tập ⊆ registry: không tên khai báo nào biến mất khỏi registry.
    //     (membership ở bước 2 đã phủ, giữ lại để union là song ánh tường minh.)
    const ghosts = [...classified].filter((n) => !registrySet.has(n));
    expect(ghosts, 'không tên khai báo nào được vắng mặt trong registry').toEqual([]);

    expect(classified.size).toBe(registry.length);
    expect(registry).toHaveLength(161);

    // 5) Nhóm read-GET không được chứa động từ ghi — chốt nó thật là nhóm read.
    const writeVerb = /^(create|update|delete|upsert|remove|revoke|rotate|attach|detach|assign|install|uninstall|publish|apply|restore|approve|reject|submit|register|drop|refresh|pause|resume|scan|replay|run)_/;
    expect(READ_GET_63.filter((n) => writeVerb.test(n))).toEqual([]);
  });

  it('S13b: tổng kiểm số học của bảng phân loại', () => {
    /**
     * Chốt các con số sau soát ngữ nghĩa, để chúng không trôi ở lượt sau.
     * Đây là **bảng phân loại**, không phải bằng chứng hành vi từng tool —
     * bằng chứng nằm ở S7 (REST target), R16 (không có alias), R17 (hai ca
     * trông-như-map-được thực chất không tương đương).
     */
    const TOTAL = 161;
    const READ_GET = 63;
    const READ_VIA_POST_N = 7;
    const PROVIDER_ACTION_N = 2; // translate_text + compile_intent
    const MUTATIONS = 89;
    const MUTATION_MAPPED = 41; // 40 theo tên + 1 alias
    const MUTATION_UNMAPPED = 48;

    // Tổng phải khớp: read(GET) + read(POST) + provider + mutation = 161
    expect(READ_GET + READ_VIA_POST_N + PROVIDER_ACTION_N + MUTATIONS).toBe(TOTAL);
    // Mutation phải chia hết thành mapped + unmapped
    expect(MUTATION_MAPPED + MUTATION_UNMAPPED).toBe(MUTATIONS);
    // Và 48 unmapped chia thành hai nhóm rủi ro (xem §5d của PR)
    const PRIVILEGE_AFFECTING = 22;
    const CONTENT_SCHEMA_OPS = 26;
    expect(PRIVILEGE_AFFECTING + CONTENT_SCHEMA_OPS).toBe(MUTATION_UNMAPPED);
  });
});
