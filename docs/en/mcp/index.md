# Model Context Protocol (MCP) — LumiBase

> Nguồn docs tập trung cho năng lực MCP của LumiBase. Tài liệu này mô tả **hiện trạng thực tế** trong codebase (verify theo `apps/cms/src/routes/mcp.ts`, `apps/cms/src/services/mcp-service.ts`, `packages/mcp-server/`) và là nơi quay lại để phân tích việc ứng dụng MCP cho các tính năng tương lai.

## TL;DR

LumiBase phơi bày **hai bề mặt MCP**, cùng chạy qua một codepath harness duy nhất nên quyết định của một tool gọi qua MCP **giống hệt** khi gọi trực tiếp Agent API (bất biến "MCP parity", Property 14):

| Bề mặt | Transport | Vị trí | Dùng cho |
|---|---|---|---|
| **HTTP endpoint** | Streamable HTTP (JSON-RPC 2.0, POST/response, không SSE) | `POST /api/v1/mcp` (`apps/cms/src/routes/mcp.ts`) | MCP client từ xa; tool động từ tool registry; chịu mọi guard của harness |
| **Standalone server** | Stdio (stdin/stdout) | `packages/mcp-server/` (`bin: lumibase-mcp`) | Tích hợp editor cục bộ (Claude Code, Cursor, Windsurf); 15 tool CRUD cố định |

## 1. HTTP MCP endpoint — `POST /api/v1/mcp`

Nguồn: [`apps/cms/src/routes/mcp.ts`](../../../apps/cms/src/routes/mcp.ts), [`apps/cms/src/services/mcp-service.ts`](../../../apps/cms/src/services/mcp-service.ts).

- **Transport:** Streamable HTTP — JSON-RPC 2.0 một request/một response. `GET /api/v1/mcp` trả `405 METHOD_NOT_ALLOWED` (không có server-initiated stream/SSE); client fallback plain request/response theo spec MCP.
- **Protocol versions:** `2025-06-18` (default) và `2025-03-26`. `serverInfo = { name: 'lumibase-mcp', version: '1.0.0' }`.
- **Auth → capability:** Bearer token; **roles của token trở thành capability set** truyền vào harness. ⇒ một MCP client **không bao giờ làm được nhiều hơn** cùng token đó qua Agent API. (`McpService(port).handle(body, auth.roles ?? [])`).
- **Feature gate:** cờ per-site `contentOs.mcp` (mặc định **off**). Tắt → `404 MCP_DISABLED`. (`feature-flags.ts`).
- **Methods (JSON-RPC):**
  - `initialize` — thương lượng protocol version, trả `capabilities: { tools: { listChanged: false } }`.
  - `ping`.
  - `tools/list` — liệt kê tool **đang enabled** từ `ToolRegistryService`; inputSchema rỗng mặc định `{ type: 'object' }`.
  - `tools/call` — chạy qua `AISecureHarness.execute(skillName, args, capabilities, contextMessage)`. Kết quả bọc `{ content, structuredContent, isError }`.
  - `notifications/initialized`, `notifications/cancelled` → trả `null` ⇒ HTTP `202 Accepted` không body.
- **Mapping quyết định → kết quả tool** (bất biến quan trọng):
  - `executed` → `isError: false`, data trong `structuredContent`.
  - `pending_approval` → `isError: false`, **`approvalId` nằm trong `structuredContent`**, KHÔNG phải lỗi protocol.
  - `denied` → `isError: true`.
  - Lỗi protocol chỉ dùng cho lỗi JSON-RPC thật: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params.
- **Guards kế thừa từ harness** (zero logic MCP riêng): kill switch, capability, autonomy (L0–L4), constitution pin, load guard, veto window. Xem [`docs/en/features/agent-harness-layer.md`](../features/agent-harness-layer.md).

### Tool registry (động)

Nguồn: [`apps/cms/src/services/tool-registry-service.ts`](../../../apps/cms/src/services/tool-registry-service.ts), bảng `agentTools` (`packages/database/src/schema/ai.ts`).

- Registry **gộp** core skills (từ harness `CORE_SKILLS`) + override DB (`agentTools` per-site).
- Mỗi `AgentToolDefinition` có: `inputSchema`, `outputSchema`, `riskPolicy.level` (`safe | review_required | dangerous | blocked`), `rateLimit` (per-minute, per-run), `enabled`, `owner` (`core | db | …`), `extensionId?`.
- `coreTool()` đặt `risk = dangerous` nếu skill mutate schema hoặc bắt đầu bằng `delete`.
- `evaluatePolicy(tool, runId)` kiểm tra enabled/blocked + rate limit.
- Audit: `agentToolCalls` (input/output/error/status/approvalId/cost/latency); approvals: `agentApprovals`.

## 2. Standalone MCP server — `@lumibase/mcp-server`

Nguồn: [`packages/mcp-server/`](../../../packages/mcp-server/) (v0.6.0, `@modelcontextprotocol/sdk`).

- **Transport:** Stdio (`StdioServerTransport`). Dành cho tích hợp editor cục bộ.
- **Entry:** `packages/mcp-server/src/index.ts` — `new McpServer({ name: 'lumibase', ... })`, đăng ký collection/field/item tools, `connect(StdioServerTransport)`.
- **Client:** `LumiBaseClient` — HTTP tới `/api/v1` với Bearer token + site header.
- **Config:** [`docs/en/agent-setup/mcp-config.json`](../agent-setup/mcp-config.json) — env `LUMIBASE_URL`, `LUMIBASE_SITE_ID`, `LUMIBASE_TOKEN`.

### Tool cố định (CRUD + insights read-only)

| Nhóm | Tools |
|---|---|
| Collections (7) | `list_collections`, `get_collection`, `create_collection`, `update_collection`, `delete_collection`, `diff_schema`, `apply_schema` |
| Fields (3) | `list_fields`, `upsert_field`, `delete_field` |
| Items (5) | `list_items`, `get_item`, `create_item`, `update_item`, `delete_item` |
| Insights (5, read-only) | `list_dashboards`, `get_dashboard`, `list_dashboard_panels`, `run_panel`, `query_insights` |

> **Insights (Sóng 1 — [`mcp-application-analysis.md`](mcp-application-analysis.md)):** nhóm read-only cho phép agent "hỏi số liệu" — chạy panel đã lưu hoặc query aggregate ad-hoc (`query_insights`, tool giá trị nhất). Không mutate, mang quyền đọc của token, không vào HITL; aggregation được whitelist field + cap giới hạn server-side bởi `InsightsService`. Bảng trên minh hoạ các nhóm chính; nguồn chân lý là [`packages/mcp-server/src/tools/`](../../../packages/mcp-server/src/tools/).

## 2b. Content versions qua MCP (Sóng 2 — governed harness skills)

Versioning **không** nằm ở stdio server. Nó được phơi bày dưới dạng **governed skill** chảy qua `AISecureHarness` (`POST /api/v1/mcp` → `tools/list`/`tools/call`), vì `promoteVersion` ghi đè main và **bắt buộc qua HITL** — điều stdio passthrough không làm được.

| Skill | Capability | Risk | Ghi chú |
|---|---|---|---|
| `listVersions` | `items:read` | safe | Liệt kê nhánh version của item (kèm cờ `mainChanged`). |
| `compareVersion` | `items:read` | safe | So sánh nhánh với main (field-level changes). |
| `createVersion` | `items:write` | **dangerous** | Snapshot data hiện tại vào nhánh mới. |
| `updateVersion` | `items:write` | **dangerous** | Sửa draft/tên của nhánh. |
| `deleteVersion` | `items:write` | **dangerous** | Xoá nhánh (không đụng main); dangerous theo tiền tố `delete`. |
| `promoteVersion` | `items:write` | **dangerous** | Áp nhánh lên main qua `ItemService.patch` (ghi revision + invalidate cache), rồi xoá nhánh; trả `mainDiverged`. |

- **Nguồn:** handler ở [`apps/cms/src/services/ai-harness.ts`](../../../apps/cms/src/services/ai-harness.ts) (`buildCoreSkills` → `ContentVersionService`); định nghĩa public ở [`packages/ai-skills/src/skills.ts`](../../../packages/ai-skills/src/skills.ts). Hai nơi **phải cùng key set** (test `governed-skills.test.ts`).
- **Risk:** `createVersion`/`updateVersion`/`promoteVersion` đặt cờ `dangerous`; `deleteVersion` dangerous nhờ tiền tố tên. `ToolRegistryService.coreTool` → `riskPolicy.level = 'dangerous'`, `approvalPolicy = 'before_execute'`.
- **`promoteVersion` không irreversible:** nó ghi một revision nên khôi phục được → **không** bị hard-cap L2 như schema drops; vẫn `dangerous` (HITL ở ≤L2 mặc định, cho tới khi role earn autonomy cao hơn).

## 3. Bất biến & ranh giới đã xác lập

- **MCP parity (Property 14):** quyết định `tools/call` khớp **byte-for-byte** với quyết định harness trực tiếp. Test: [`apps/cms/src/services/__tests__/mcp-parity.property.test.ts`](../../../apps/cms/src/services/__tests__/mcp-parity.property.test.ts).
- **Không có bảng `mcp_servers`/`mcp_sessions` riêng** — MCP tái dùng hạ tầng agent (approvals, tool calls, permissions). Đây là quyết định kiến trúc cố ý (zero MCP-specific state).
- **SDK không có MCP client** — MCP không phải mối quan tâm client của SDK REST.
- **Permission floor:** capability = roles của token. Mọi mở rộng MCP phải tôn trọng sàn này.

## 4. Trang liên quan

- [`mcp-application-analysis.md`](mcp-application-analysis.md) — phân tích ứng dụng MCP cho 7 spec Directus-inspired.
- [`docs/en/agent-setup/claude-code.md`](../agent-setup/claude-code.md) — hướng dẫn nối MCP server vào Claude Code.
- [`docs/en/features/agent-harness-layer.md`](../features/agent-harness-layer.md) — guard của harness mà MCP kế thừa.

## 5. Nguồn sự thật (để cập nhật khi code đổi)

| Khía cạnh | File |
|---|---|
| HTTP endpoint + gating | `apps/cms/src/routes/mcp.ts` |
| JSON-RPC adapter + protocol versions | `apps/cms/src/services/mcp-service.ts` |
| Tool registry + risk/rate policy | `apps/cms/src/services/tool-registry-service.ts` |
| Bảng agent (tools/calls/approvals) | `packages/database/src/schema/ai.ts` |
| Standalone server + 15 tool | `packages/mcp-server/src/` |
| Feature flag `contentOs.mcp` | `apps/cms/src/services/feature-flags.ts` |
| Parity test | `apps/cms/src/services/__tests__/mcp-parity.property.test.ts` |
