---
version: 15
lastUpdated: 2026-11-12T20:00:42.665Z
sourceLang: vi
contentHash: 83e0c7cf80c59b12
codeVerified: 2026-11-12T20:00:42.665Z
codeVerifiedHash: 83e0c7cf80c59b12
codeVerifiedClaims: 28
---

# Model Context Protocol (MCP) — LumiBase

> Nguồn docs tập trung cho năng lực MCP của LumiBase. Tài liệu này mô tả **hiện trạng thực tế** trong codebase (verify theo `apps/cms/src/routes/mcp.ts`, `apps/cms/src/services/mcp-service.ts`, `packages/mcp-server/`) và là nơi quay lại để phân tích việc ứng dụng MCP cho các tính năng tương lai.

## TL;DR

LumiBase phơi bày **hai bề mặt MCP**, các tool site có quản trị dùng cùng harness site với Agent API (bất biến "MCP parity", Property 14). Tool organization dùng harness organization và ranh giới phê duyệt của người dùng:

| Bề mặt | Transport | Vị trí | Dùng cho |
|---|---|---|---|
| **HTTP endpoint** | Streamable HTTP (JSON-RPC 2.0, POST/response, không SSE) | `POST /api/v1/mcp` (`apps/cms/src/routes/mcp.ts`) | MCP client từ xa; tool động từ tool registry; chịu mọi guard của harness |
| **Standalone server** | Stdio (stdin/stdout) | `packages/mcp-server/` (`bin: lumibase-mcp`) | Tích hợp editor cục bộ (Claude Code, Cursor, Windsurf); bộ tool CRUD cố định |

## 1. HTTP MCP endpoint — `POST /api/v1/mcp`

Nguồn: [`apps/cms/src/routes/mcp.ts`](../../../apps/cms/src/routes/mcp.ts), [`apps/cms/src/services/mcp-service.ts`](../../../apps/cms/src/services/mcp-service.ts).

- **Transport:** Streamable HTTP — JSON-RPC 2.0 một request/một response. `GET /api/v1/mcp` trả `405 METHOD_NOT_ALLOWED` (không có server-initiated stream/SSE); client fallback plain request/response theo spec MCP.
- **Protocol versions:** `2025-06-18` (default) và `2025-03-26`. `serverInfo = { name: 'lumibase-mcp', version: '1.0.0' }`.
- **Auth → capability:** Bearer token; capability set được **resolve từ RBAC bundle sống** của token (#472), không phải từ `auth.roles`. ⇒ một MCP client **không bao giờ làm được nhiều hơn** cùng token đó qua REST — và cũng không ít hơn, điều mà cách đọc `auth.roles` cũ làm sai (role id không bao giờ khớp `items:write`). Xem [`governed-tool-contract.md`](governed-tool-contract.md) mục 4.
- **Feature gate:** cờ per-site `contentOs.mcp` (mặc định **off**). Tắt → `404 MCP_DISABLED`. (`feature-flags.ts`).
- **Methods (JSON-RPC):**
  - `initialize` — thương lượng protocol version, trả `capabilities: { tools: { listChanged: false } }`.
  - `ping`.
  - `tools/list` — liệt kê tool **đang enabled** từ `ToolRegistryService`; inputSchema suy ra từ schema canonical trong `@lumibase/contracts` (chỉ skill chưa có schema mới rơi về `{ type: 'object' }`).
  - `tools/call` — chạy qua `AISecureHarness.execute(skillName, args, capabilities, contextMessage)`. Kết quả bọc `{ content, structuredContent, isError }`.
  - `notifications/initialized`, `notifications/cancelled` → trả `null` ⇒ HTTP `202 Accepted` không body.
- **Mapping quyết định → kết quả tool** (bất biến quan trọng):
  - `executed` → `isError: false`, data trong `structuredContent`.
  - `pending_approval` → `isError: false`, **`approvalId` nằm trong `structuredContent`**, KHÔNG phải lỗi protocol.
  - `waiting_user` (tool `askUser`, #710) → `isError: false`, **`questionId` nằm trong `structuredContent`**; run đỗ tới khi một người trả lời, KHÔNG phải lỗi protocol.
  - `denied` → `isError: true`.
  - Lỗi protocol chỉ dùng cho lỗi JSON-RPC thật: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params.
- **Guards kế thừa từ harness** (zero logic MCP riêng): kill switch, capability, autonomy (L0–L4), constitution pin, load guard, veto window. Xem [`docs/en/features/agent-harness-layer.md`](../features/agent-harness-layer.md).

### Access token OAuth 2.1 (#346)

Các trợ lý dạng hosted (ChatGPT, claude.ai) không nhận API key; chúng yêu cầu MCP endpoint là một protected resource theo OAuth 2.1. LumiBase chỉ đóng vai **resource** — không bao giờ phát hành token. Việc đó do một authorization server bên ngoài đảm nhận, và operator khai báo nó bằng biến môi trường. Nguồn: [`apps/cms/src/modules/mcp-oauth/`](../../../apps/cms/src/modules/mcp-oauth/).

| Biến | Ý nghĩa |
|---|---|
| `MCP_OAUTH_ISSUER` | Giá trị `iss` mà mọi token được chấp nhận phải mang; được công bố là authorization server. |
| `MCP_OAUTH_JWKS_URI` | Nơi server đó công bố khóa ký. |
| `MCP_OAUTH_RESOURCE` | URL chuẩn của MCP endpoint này. Token phải ghi nó trong `aud`. |
| `MCP_OAUTH_SUBJECT` | `user_id` (mặc định) hoặc `external_id`: cột nào của `users` mà `sub` định danh. |

Cả ba biến đầu phải được đặt, dưới dạng URL `https`, nếu không tính năng tắt và những điều dưới đây không áp dụng.

- **Nơi được chấp nhận:** chỉ `POST /api/v1/mcp`. Cùng token đó không phải là credential trên bất kỳ route nào khác.
- **Những gì được kiểm tra:** chữ ký bất đối xứng (`RS256`, `PS256`, `ES256`, `EdDSA`) theo JWKS, `iss`, `aud`, `exp`, `sub`. Token phát hành cho audience khác bị từ chối, nên không thể chuyển tiếp sang đây. Claim tùy chọn: `site_id` phải bằng site của request; `token_version` phải bằng giá trị hiện tại của user, nên đổi mật khẩu sẽ thu hồi quyền đã cấp.
- **Danh tính:** một user LumiBase đang tồn tại và active. Membership của site và capability được resolve đúng như với phiên của chính user đó — bản thân token không cấp thêm gì.
- **Scope là trần, không bao giờ là quyền được cấp:**

  | Scope | Giữ lại |
  |---|---|
  | `lumibase.read` | chỉ các capability `:read` |
  | `lumibase.write` | thêm quyền ghi trên `items` và `translations` |
  | `lumibase.admin` | mọi thứ user đang có, skill control-plane và tool organization |

  Một administrator cấp cho client scope `lumibase.read` thì với client đó chỉ là người đọc. Thiếu `lumibase.admin`, skill control-plane trả `403 CONTROL_PLANE_FORBIDDEN` và tool organization trả `403 ORGANIZATION_FORBIDDEN`.
- **Discovery:** `GET /.well-known/oauth-protected-resource/api/v1/mcp` trả metadata theo RFC 9728, và mọi `401` từ route MCP đều mang `WWW-Authenticate: Bearer resource_metadata="…"`.
- **Gợi ý tool:** `tools/list` trả `title` và `annotations` (`readOnlyHint`, `destructiveHint`) cho từng tool trong registry, suy ra từ capability yêu cầu và mức rủi ro. Đây là gợi ý cho client và không tham gia vào việc phân quyền.

### Tool registry (động)

Nguồn: [`apps/cms/src/services/tool-registry-service.ts`](../../../apps/cms/src/services/tool-registry-service.ts), bảng `agentTools` (`packages/database/src/schema/ai.ts`).

- Registry **gộp** core skills (từ harness `CORE_SKILLS`) + override DB (`agentTools` per-site).
- Mỗi `AgentToolDefinition` có: `inputSchema`, `outputSchema`, `riskPolicy.level` (`safe | review_required | dangerous | blocked`), `rateLimit` (per-minute, per-run), `enabled`, `owner` (`core | db | …`), `extensionId?`.
- `coreTool()` đặt `risk = dangerous` nếu skill mutate schema hoặc bắt đầu bằng `delete`.
- `evaluatePolicy(tool, runId)` kiểm tra enabled/blocked + rate limit.
- Audit: `agentToolCalls` (input/output/error/status/approvalId/cost/latency); approvals: `agentApprovals`.


## 2. Standalone MCP server — `@lumibase/mcp-server`

Nguồn: [`packages/mcp-server/`](../../../packages/mcp-server/) (dựng trên `@modelcontextprotocol/sdk`; version lấy ở `package.json` của chính package — không pin lại ở đây để tránh thêm một chỗ trôi lệch).

- **Transport:** Stdio (`StdioServerTransport`). Dành cho tích hợp editor cục bộ.
- **Entry:** `packages/mcp-server/src/index.ts` — `new McpServer({ name: 'lumibase', ... })`, đăng ký collection/field/item tools, `connect(StdioServerTransport)`.
- **Client:** `LumiBaseClient` — HTTP tới `/api/v1` với Bearer token + site header.
- **Config:** [`docs/en/agent-setup/mcp-config.json`](../../en/agent-setup/mcp-config.json) — env `LUMIBASE_URL`, `LUMIBASE_SITE_ID`, `LUMIBASE_TOKEN`.
- **Studio:** trang *Data model → Set up MCP for your IDE* (`/data-model/mcp-setup`) tạo API key riêng gắn role, sinh config cho Cursor/Claude Desktop/VS Code, và có mục **Try these prompts** — prompt mẫu copy được, chia nhóm Explore/Content/Schema/Operations, gắn nhãn `Read-only`/`Writes data`/`Admin role`, có bản tiếng Anh và tiếng Việt (nút chuyển ngôn ngữ, mặc định theo ngôn ngữ giao diện Studio). Danh sách ở [`apps/studio/src/modules/data-model/mcp-prompts.ts`](../../../apps/studio/src/modules/data-model/mcp-prompts.ts); mỗi prompt khai các tool nó dùng và test đối chiếu với tool mà server thật sự đăng ký.

### Thông tin xác thực organization (ADR-013)

Ví dụ key organization không ghim site. Mẫu chỉ đọc; đặt `LUMIBASE_READ_ONLY=false` để yêu cầu ghi, bật MCP organization trong Settings và duyệt yêu cầu bằng tài khoản người dùng.

```json
{
  "mcpServers": {
    "lumibase-organization": {
      "command": "npx",
      "args": [
        "-y",
        "@lumibase/mcp-server"
      ],
      "env": {
        "LUMIBASE_URL": "http://localhost:1989",
        "LUMIBASE_TOKEN": "lbo_<organization-key>",
        "LUMIBASE_READ_ONLY": "true"
      }
    }
  }
}
```



Đặt `LUMIBASE_READ_ONLY=true` để chỉ công bố tool có annotation chỉ đọc. Ở chế độ này client cũng từ chối mọi request không phải GET, trừ một danh sách cố định endpoint xem trước/truy vấn (diff schema, tra cứu translation memory, panel insight, kiểm tra quyền và truy cập, compile intent), nên một tool không thể ghi dù tên của nó trông như chỉ đọc. Với key `lbk_`, `LUMIBASE_SITE_ID` vẫn bắt buộc và danh sách tool site hiện có không đổi. Với key `lbo_`, bỏ site để có tám tool organization (`get_organization`, `list_sites`, `create_site`, `delete_site`, `transfer_site`, `list_org_members`, `invite_org_member`, `create_org_key`) cùng các tool site bắt buộc truyền đối số `site`. Ghim một site sẽ công bố các tool site cũ và hai tool đọc organization đầu tiên. Các lời gọi song song không dùng chung header site.

Tool ghi organization luôn đi qua HTTP endpoint có quản trị, kể cả khi `LUMIBASE_MCP_GOVERNED=off`; không fallback sang REST. Bật setting organization `contentOs.mcp.allowOrganizationTools`; biến toàn cục `LUMIBASE_MCP_ORG_TOOLS=off` có quyền tắt ưu tiên. Mọi thay đổi organization đều chờ người duyệt. Đối số `confirm` chỉ xác nhận ý định, không thay thế phê duyệt. Owner/admin đọc `/api/v1/orgs/:orgId/approvals`, mở `/:approvalId`, rồi gửi `{"decision":"approved"}` hoặc `{"decision":"rejected"}` tới `/:approvalId/decide`. Thao tác dành riêng cho owner vẫn cần owner; chuyển site cần cùng một người là owner ở cả hai organization. API key không được duyệt hay đọc biên nhận. Token organization mới chỉ hiện trong biên nhận dành cho người duyệt. Quyền hiện tại của bên yêu cầu được kiểm tra lại khi duyệt; thao tác và biên nhận được commit nguyên tử. Approval organization có cha organization thật (migration `0025`), kể cả organization không có site.

### Tool cố định (CRUD + insights read-only)

| Nhóm | Tools |
|---|---|
| Collections (7) | `list_collections`, `get_collection`, `create_collection`, `update_collection`, `delete_collection`, `diff_schema`, `apply_schema` |
| Fields (3) | `list_fields`, `upsert_field`, `delete_field` |
| Items (5) | `list_items`, `get_item`, `create_item`, `update_item`, `delete_item` |
| Insights (5, read-only) | `list_dashboards`, `get_dashboard`, `list_dashboard_panels`, `run_panel`, `query_insights` |
| Editorial (4) | `list_reviews`, `submit_review`, `approve_content`, `reject_content` |
| Releases (6) | `list_releases`, `get_release`, `create_release`, `update_release`, `publish_release`, `delete_release` |
| Deployments (4, read-only) | `list_deployment_targets`, `list_deployments`, `get_deployment`, `get_deployment_logs` |
| Shares (2) | `create_share`, `revoke_share` |
| TM / presets / misc | `list_tm`/`lookup_tm`/`translate_text`/`upsert_tm`/`update_tm`/`delete_tm`, `get_effective_preset`, `list_preset_bookmarks`, `list_transform_presets`, `get_flow_run`, `get_site` |

> **Insights (Sóng 1 — [`mcp-application-analysis.md`](mcp-application-analysis.md)):** nhóm read-only cho phép agent "hỏi số liệu" — chạy panel đã lưu hoặc query aggregate ad-hoc (`query_insights`, tool giá trị nhất). Không mutate, mang quyền đọc của token, không vào HITL; aggregation được whitelist field + cap giới hạn server-side bởi `InsightsService`. Bảng trên minh hoạ các nhóm chính; nguồn chân lý là [`packages/mcp-server/src/tools/`](../../../packages/mcp-server/src/tools/).

### Cố ý KHÔNG đưa lên MCP (loại trừ có chủ đích)

Không phải bỏ sót — mỗi mục có lý do:

| Bề mặt | Vì sao loại trừ |
|---|---|
| `/realtime` (SSE/WS) | MCP là request/response; không streaming. Agent dùng `cdc_events_read` để poll. |
| Signed media delivery URL | URL đã ký dựng ở edge bằng server secret; không có REST endpoint trả URL. `/files/presigned-url` chỉ cho upload. |
| Binary `/files`, `/uploads` | Up/download nhị phân stream ở edge — không hợp text tool. |
| Trigger deploy | Side-effect ra host ngoài → **dangerous**, chỉ ở governed skill `triggerDeployment` (HITL). Stdio chỉ có phần đọc. |
| `/admin/encryption`·`/admin/sar`·`/admin/erasure`·`/retention`·`/scim-tokens` | Security/GDPR/enterprise admin nhạy cảm — crypto/SSRF/PII logic ở REST, không passthrough. |
| `/auth`, `/me/*` | Auth/session + self-service của con người, không phải content-ops. |
| `/typegen`·`/domains`·`/integrations/git`·`/firebase-sync`·`/push` | Dev/infra tooling, giá trị agent thấp. |

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
- **Permission floor:** capability = RBAC bundle của token (một mô hình dùng chung với REST). Mọi mở rộng MCP phải tôn trọng sàn này.
- **Governed tool contract:** schema, validate, gate write, decision shape và tập tool stdio được governance kiểm soát — tất cả nằm ở [`governed-tool-contract.md`](governed-tool-contract.md).

## 4. Trang liên quan

- [`governed-tool-contract.md`](governed-tool-contract.md) — hợp đồng dùng chung cho hai transport: nguồn schema, thứ tự validate, gate autonomy, decision shape, và tập tool stdio được governance kiểm soát.
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
| Standalone server + các tool | `packages/mcp-server/src/` |
| Feature flag `contentOs.mcp` | `apps/cms/src/services/feature-flags.ts` |
| Parity test | `apps/cms/src/services/__tests__/mcp-parity.property.test.ts` |
