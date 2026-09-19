---
version: 2
lastUpdated: 2026-09-19T13:44:33.469Z
sourceLang: vi
contentHash: 533443703534ed06
codeVerified: 2026-09-19T13:44:33.469Z
codeVerifiedHash: 533443703534ed06
codeVerifiedClaims: 22
---

# Governed tool contract — một hợp đồng cho hai transport MCP

> LumiBase có hai bề mặt MCP (xem [`index.md`](index.md)). Trước #454 chúng **không** cùng một hợp đồng: cùng một thao tác logic có thể được governance kiểm soát ở bề mặt này và không ở bề mặt kia, và schema quảng bá cho client không nói đúng cái mà server thật sự nhận. Tài liệu này ghi hợp đồng sau khi đã hợp nhất.

## TL;DR

| Khía cạnh | Trước | Nay |
|---|---|---|
| Schema quảng bá trên `tools/list` | `{type:'object'}` cho mọi skill không tự khai | Suy ra từ Zod canonical trong `@lumibase/contracts` |
| Validate input | Không có — args sai tới được service | Từ chối **trước** mọi side effect, có mã `VALIDATION` |
| Gate write | Chỉ khi skill bị xếp `dangerous` | Mọi skill có capability ghi đều qua autonomy resolution |
| Capability của caller | `auth.roles` (role **id**, so khớp chuỗi) | Resolve từ RBAC bundle như REST |
| Kết quả mutation ở stdio | Câu khẳng định tự dựng ("deleted") | Phản ánh `executed` / `pending_approval` / `denied` |
| Mutation ở stdio | Gọi REST trực tiếp, bỏ qua harness | 27 tool đi qua harness; phần còn lại được **khai** là chưa governed |

## 1. Nguồn schema duy nhất

`packages/contracts/src/agent-tools/schemas.ts` là nguồn chuẩn. Một định nghĩa Zod, hai người dùng:

- harness validate `args` theo đúng nó (`validateAgentToolInput`);
- `tools/list` quảng bá JSON Schema suy ra từ chính nó (`jsonSchemaFor`, qua `z.toJSONSchema`).

Ba nguyên tắc khi thêm schema:

1. **Chỉ khai field mà handler thật sự đọc.** Quảng bá rộng hơn handler là hứa một hợp đồng không được tôn trọng.
2. **`.strict()`** — field lạ bị **từ chối**, không rụng im lặng. Đây chính là lớp lỗi của `update_item` cũ: REST strip key ngoài envelope `data`, trả `200 OK` với patch rỗng.
3. **Giữ đúng tên key mà handler đọc.** Cần đổi tên thì làm ở tầng alias mapping, không phải ở schema.

Skill chưa có schema thì harness **bỏ qua** validation — fail-open **có chủ ý**, để không phá hành vi read đang chạy. Tập skill đã có schema lấy bằng `agentToolNamesWithSchema()`.

Skill tự khai `inputSchema` thì bản tự khai **thắng**: chúng được viết theo handler và có bản mô tả rộng hơn tập canonical hiện tại.

## 2. Thứ tự kiểm tra trong `execute()`

Thứ tự này là hợp đồng, không phải chi tiết triển khai — mỗi bước đứng ở vị trí đó vì một lý do cụ thể:

1. **Kill switch** — site/role bị đóng băng thì không có gì được tạo ra.
2. **Validate input** — **trước `ensureRun`**. Đặt sau sẽ để lại một run `running` và một tool call `running` cho input không bao giờ thực thi được. Input sai ⇒ **không ghi gì cả**, trả `denied` + `code: 'VALIDATION'` nêu tên field.
3. **`ensureRun` + `appendToolCall`** — từ đây mọi thứ có dấu vết audit.
4. **Capability** — xem mục 4.
5. **Tool policy** (risk/rate per-site từ `agent_tools`).
6. **Write budget** (`maxWritesPerMinute` theo intent).
7. **Risk + autonomy** — xem mục 3.

## 3. Gate write không phụ thuộc phân loại `dangerous`

`AutonomyService` tự định nghĩa: **L0** = không side effect, **L1** = mọi hành động tạo approval, **L2** = hành động an toàn chạy / nguy hiểm chờ approval, **L3** = veto window, **L4** = autopilot.

Trước đây trust gradient chỉ vào được qua nhánh `isDangerous`, nên một content write thường (`createItem`, capability `items:write`) đi thẳng xuống nhánh "safe skill — execute directly": intent cap L0 vẫn ghi, L1 không hỏi approval. Nay:

| Level | Skill ghi (không control-plane) | Skill control-plane |
|---|---|---|
| L0 | `denied`, `code: 'AUTONOMY_SHADOW'` — không ghi, và **không** biến thành approval | approval |
| L1 | approval (cùng bảng, cùng id, cùng endpoint decide) | approval |
| L2 | chạy | approval |
| L3 | chạy | staging + veto window (nếu bật cờ) |
| L4 | chạy | chạy |

**Tương thích ngược:** `resolveAutonomy` default **L2** cho capability an toàn khi không có grant. Cài đặt chưa cấu hình autonomy hành xử **y như trước**; gate chỉ có tác dụng khi có người hạ level tường minh (grant row hoặc `autonomyCap` của intent).

**Read không bị ảnh hưởng:** gate chỉ bám capability khớp `:(write|update|create|delete)$`.

## 4. Capability đến từ RBAC, không từ `auth.roles`

`withAuth` đặt `auth.roles` = một role **id** cho user thường (`role_7fK…`), `[]` cho API key, và chuỗi `'admin'` chỉ cho bootstrap/dev. So khớp chuỗi chính xác với `items:write` thì role id không bao giờ khớp ⇒ gate thực tế là **admin-hoặc-không**, và một site admin có role `adminAccess` thật (không phải bootstrap user) bị từ chối.

Nay mọi transport gọi cùng một resolver (`services/governed-capabilities.ts`), dựa trên compiled RBAC bundle:

| Quyền trong bundle | Capability suy ra |
|---|---|
| bundle `admin` | `['admin']` (không phải `*`) |
| `read` trên collection | `items:read` |
| `create` | `items:create`, `items:write` |
| `update` | `items:update`, `items:write` |
| `delete` | `items:delete`, `items:write` |
| collection `schema`, action `schema:*` | chính action đó |
| các domain khác | **bỏ qua**, không đoán |

Hệ quả cần biết: vì chỉ `items:*` và `schema:*` được suy ra cho non-admin, mọi skill control-plane (`access:*`, `config:*`, `flows:*`, `intents:*`, `cdc:manage`, `deployments:*`, `users:*`, `teams:*`, `api-keys:*`, `extensions:*`) trên thực tế **chỉ admin dùng được**. Đó là trạng thái fail-closed: muốn mở cho non-admin thì phải thêm pseudo-resource vào bảng `permissions` và mở rộng bảng suy diễn ở trên — không phải nới `checkCapabilities`.

**Fail-closed hai lớp:** không định danh được principal (anonymous) ⇒ không capability nào. Resolve lỗi (DB down) ⇒ `denied`, **không** throw ra route và **không** fallback về giá trị dễ dãi.

**Công việc queue và approval** mang `AuthenticatedPrincipalRef` — một tham chiếu định danh, **không** phải snapshot capability — và worker resolve lại lúc nhận job. Nhờ đó key bị revoke hoặc user bị hạ quyền trong lúc job nằm chờ là **có hiệu lực**.

**Giới hạn đã biết:** approval được phê duyệt thực thi với capability của **người quyết định**, không phải của người yêu cầu. Capability của người yêu cầu đã được kiểm lúc hành động bị park; một người phê duyệt là đang nhận trách nhiệm dưới quyền của chính họ. Bảng `ai_approvals`/`agent_approvals` hiện **không** lưu principal ref nên không có đường re-resolve người yêu cầu; thêm cột là một migration, nằm ngoài phạm vi thay đổi này.

## 5. Hợp đồng decision và hai không gian approval ID

`tools/call` trả quyết định **bên trong** kết quả tool, không phải lỗi protocol:

```jsonc
{
  "status": "executed" | "pending_approval" | "denied",
  "code": "VALIDATION | AUTONOMY_SHADOW | …",
  "data": {},
  "approvalId": "…",
  "approvalSpace": "agent" | "legacy_ai",
  "agentApprovalId": "…",
  "legacyApprovalId": "…",
  "runId": "…",
  "message": "…"
}
```

`code` chỉ có khi `denied`; `data` chỉ có khi `executed`; nhóm `approval*` chỉ có khi `pending_approval`.

`isError` bằng `status === 'denied'`.

Hai không gian id tồn tại và **không** thay thế nhau được — `execute()` insert vào **cả hai** bảng, và chúng được quyết định ở hai endpoint khác nhau:

| `approvalSpace` | Bảng | Endpoint decide |
|---|---|---|
| `agent` | `lumibase_agent_approvals` | `POST /api/v1/agent/approvals/{approvalId}/decide` |
| `legacy_ai` | `lumibase_ai_approvals` | `POST /api/v1/ai/approvals/{approvalId}/decide` |

Trước đây hợp đồng gộp `agentApprovalId ?? approvalId` vào một field, nên client giữ một id trông hợp lệ mà không cách nào biết nó thuộc bảng nào. `approvalId` giữ nguyên nghĩa cũ (ưu tiên agent) để client hiện có không đổi; `approvalSpace` là phần thêm mới nói rõ ra.

## 6. stdio: tool nào được governance kiểm soát

`packages/mcp-server/src/governed.ts` giữ hai bảng.

**`GOVERNED_TOOLS` (27 tool)** — đi qua `POST /api/v1/mcp` `tools/call`. Tập này được **đo**, không chọn theo cảm tính: với mỗi tool ứng viên, property quảng bá (trừ `confirm`) được so với property của contract canonical; chỉ nhận khi không có property thừa và không có required nào không tới được. Ba tool cần rename tường minh:

| Tool | Skill | Rename |
|---|---|---|
| `delete_field` | `deleteField` | `field_name` → `name` (kèm `force`, xem dưới) |
| `add_team_member` | `addTeamMember` | `id` → `teamId` |
| `remove_team_member` | `removeTeamMember` | `id` → `teamId` |

`confirm` là prompt cho người vận hành, không phải argument của skill, nên bị **bỏ** chứ không forward.

Ngược lại, `force` của `delete_field` **được** forward: `SchemaService.deleteField` nhận `FieldDeleteOptions.force` và REST truyền `?force=true`, nên nếu đường governed không diễn đạt được nó thì governed sẽ là chỗ duy nhất từ chối một arg mà REST nhận. Nguyên tắc chung: arg nào handler tôn trọng thì khai vào contract; arg nào chỉ dành cho người vận hành thì bỏ. Ranh giới này được `governed-binding-contract.test.ts` tính lại từ registry ở mỗi lần chạy test — trước đó nó chỉ được đo một lần bằng script rồi sửa tay, và đúng `force` bị bỏ sót.

**`UNGOVERNED_MUTATIONS`** — vẫn gọi REST, kèm lý do từng tool:

| Lý do | Nghĩa |
|---|---|
| `contract-narrower-than-tool` | Skill có, nhưng contract canonical hẹp hơn surface tool đang quảng bá. Route vào sẽ **từ chối** đúng những arg caller đang gửi; rụng im lặng lại chính là lớp lỗi đang sửa. Ví dụ `create_collection` thừa 16 property |
| `no-canonical-contract` | Skill có, chưa có schema canonical nên không có gì để validate |
| `no-skill` | Không có skill tương ứng — không có đích để route |

Đây là **khoảng trống được khai báo**, không phải khoảng trống bị che. Tripwire `S16` fail nếu một mutation tool không thuộc bảng nào, nên tập này không thể tự lớn lên trong im lặng.

### Chế độ hoạt động

`LUMIBASE_MCP_GOVERNED`:

| Giá trị | Hành vi |
|---|---|
| `auto` (mặc định) | Probe một lần. Có governance thì dùng; không có thì fallback REST kèm **cảnh báo stderr một lần** |
| `on` / `true` / `1` | **Từ chối** thay vì fallback. Đây là giá trị đúng cho deployment bắt buộc governance |
| `off` / `false` / `0` | Giữ hành vi trước #454 |

Mặc định là `auto` vì `contentOs.mcp` cũng default **off** — mặc định `on` sẽ phá mọi cài đặt hiện có ngay khi upgrade.

`auto` là tiện lợi, **không phải** một tính chất bảo mật: fallback nó thực hiện được nói ra, nhưng deployment không được phép thực thi write ungoverned thì phải đặt `on`. Lý do: một fallback kích hoạt đúng lúc governance không khả dụng chính là một đường vòng qua governance.

Ghi chú: cảnh báo đi ra **stderr**. stdout là transport MCP, ghi vào đó làm hỏng luồng protocol.

## 7. Nguồn sự thật

| Khía cạnh | File |
|---|---|
| Schema canonical | `packages/contracts/src/agent-tools/schemas.ts` |
| Validate + autonomy gate + park approval | `apps/cms/src/services/ai-harness.ts` |
| Hợp đồng decision + không gian approval id | `apps/cms/src/services/mcp-service.ts` |
| Resolve capability | `apps/cms/src/services/governed-capabilities.ts`, `effective-capability-service.ts` |
| Bảng governed/ungoverned + mode | `packages/mcp-server/src/governed.ts` |
| Render decision ở stdio | `packages/mcp-server/src/tools/_shared.ts` |
