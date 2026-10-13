---
version: 7
lastUpdated: 2026-09-26T03:52:30.139Z
sourceLang: vi
contentHash: 4f411aaa72bbc641
codeVerified: 2026-09-26T03:52:30.139Z
codeVerifiedHash: 4f411aaa72bbc641
codeVerifiedClaims: 36
translatedFrom: en
sourceHash: b9ca7b4d798de9be
mtEngine: manual
syncStatus: human-translated
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
| Mutation ở stdio | Gọi REST trực tiếp, bỏ qua harness | 33 tool đi qua harness; phần còn lại được **khai** là chưa governed |

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

**Hành động được phê duyệt thực thi với `requester ∩ decider`.** Cả hai phía đều được đọc lại ở đúng thời điểm phê duyệt, và cả hai đều phải còn cho phép. Cột `agent_approvals.requested_by_principal` lưu người yêu cầu — dưới dạng **tham chiếu**, không phải snapshot capability — nên một người yêu cầu bị hạ quyền, bị revoke API key hoặc mất quyền thành viên site trong lúc approval nằm chờ thì hành động của họ không được thực thi. Chỉ dùng quyền người quyết định sẽ cho một người yêu cầu đã bị revoke vẫn hành động được; chỉ dùng quyền người yêu cầu sẽ cho approval nới rộng quá những gì người quyết định được làm.

Người yêu cầu được ghi ở một trong hai dạng, vì không phải người yêu cầu nào cũng là con người:

```jsonc
{ "kind": "principal", "ref": { "type": "user",    "siteId": "…", "userId": "…" } }
{ "kind": "principal", "ref": { "type": "api_key", "siteId": "…", "apiKeyId": "…" } }
{ "kind": "agentRole", "role": "translator", "intentId": "…", "autonomyCap": 2 }
```

Công việc gốc reconciler không có principal là người: thẩm quyền là intent đã khai quy tắc, và biên capability là agent role — nên vô hiệu hoá role đó cũng dừng luôn những gì nó đã park.

**Fail-closed khi thiếu provenance.** Một approval được park trước khi có cột này thì không resolve được, và bị từ chối với `APPROVAL_PROVENANCE_MISSING` thay vì rơi về quyền của người quyết định — chính cái fallback đó là hành vi đang được thay thế. Những approval như vậy phải được yêu cầu lại sau khi nâng cấp; header của migration có sẵn câu truy vấn liệt kê chúng. Các mã từ chối: `APPROVAL_PROVENANCE_MISSING`, `APPROVAL_PROVENANCE_INVALID`, `REQUESTER_REVOKED`, `REQUESTER_ROLE_UNAVAILABLE`, `REQUESTER_RESOLUTION_FAILED`.

**Phạm vi row và field không thuộc tập capability — và nó CŨNG được áp.** Token capability không diễn đạt được "chỉ field `body` của `posts`", nên phép giao ở trên chỉ là nửa thô. Trong suốt quá trình quyết định, `ItemService` đang thực thi được rebind sang permission context của **người yêu cầu**, nên phép ghi đi qua đúng row rule và field mask của họ như thể chính họ thực hiện.

Khoảng trống đó từng có thật: một API key park một phép update `title`, quyền của nó bị thu hẹp còn `body` trong lúc approval chờ, gọi trực tiếp thì bị từ chối `Permission does not allow writing field(s): title` — nhưng approval **vẫn ghi được `title`**, vì skill chạy trên ItemService của admin đã duyệt.

Hai giới hạn, nói ra thay vì để ngầm hiểu:

- **Duyệt là việc CHỈ admin làm được, và đó là điều làm cho luật này đủ.** Phạm vi row/field của người quyết định không được giao với của người yêu cầu — giao hai permission context không phải một phép toán có định nghĩa trong policy DSL. Điều đó đúng **vì** mọi cửa vào quyết định đều đòi admin của site: `POST /agent/approvals/:id/decide`, đường agent-reviewer, và `POST /ai/approvals/:id/decide` cũ đều nằm sau cửa gác control-plane admin, mà admin thì không có mask nào để giao. Test hồi quy từ chối non-admin ở cả ba cửa, kể cả một member nắm đúng quyền ghi mà hành động đang bị giữ cần — làm được một hành động không có nghĩa là được phép duyệt nó. Nắm một capability như `approvals:decide` **không** đủ: nó không nói gì về việc người nắm nó có field mask hay không, nên muốn mở cửa cho non-admin thì phải quyết định và thực thi phạm vi của họ trước, không phải ghi một ngoại lệ vào tài liệu.
- **Người yêu cầu dạng `agentRole` không có row/field context nào**, theo đúng bản chất — một role là tập capability, không phải principal có policy. Với việc của reconciler thì kiểm capability cộng autonomy cap của intent là toàn bộ cửa gác.

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

**`GOVERNED_TOOLS` (33 tool)** — đi qua `POST /api/v1/mcp` `tools/call`. Tập này được **đo**, không chọn theo cảm tính: với mỗi tool ứng viên, property quảng bá (trừ `confirm`) được so với property của contract canonical; chỉ nhận khi không có property thừa và không có required nào không tới được. Bốn tool cần rename tường minh:

| Tool | Skill | Rename |
|---|---|---|
| `delete_field` | `deleteField` | `field_name` → `name` (kèm `force`, xem dưới) |
| `add_team_member` | `addTeamMember` | `id` → `teamId` |
| `remove_team_member` | `removeTeamMember` | `id` → `teamId` |
| `delete_cdc_subscription` | `deleteCdcSubscription` | `id` → `subscriptionId` |

`confirm` là prompt cho người vận hành, không phải argument của skill, nên bị **bỏ** chứ không forward.

Ngược lại, `force` của `delete_field` **được** forward: `SchemaService.deleteField` nhận `FieldDeleteOptions.force` và REST truyền `?force=true`, nên nếu đường governed không diễn đạt được nó thì governed sẽ là chỗ duy nhất từ chối một arg mà REST nhận. Nguyên tắc chung: arg nào handler tôn trọng thì khai vào contract; arg nào chỉ dành cho người vận hành thì bỏ. Ranh giới này được `governed-binding-contract.test.ts` tính lại từ registry ở mỗi lần chạy test — trước đó nó chỉ được đo một lần bằng script rồi sửa tay, và đúng `force` bị bỏ sót.

**Nhận đủ arg là điều kiện cần, chưa phải điều kiện đủ.** Route thay handler REST bằng handler của skill, nên skill nào bỏ qua một bước kiểm tra mà route REST có (xác minh chữ ký, gate graph hay cron) sẽ biến "governed" thành "governed nhưng yếu hơn". Vòng bổ sung schema canonical cho nhóm `no-canonical-contract` áp thêm phép đo này. Kết quả cho mười tool của nhóm:

| Tool | Skill | Kết quả | Căn cứ |
|---|---|---|---|
| `create_relation` | `createRelation` | governed | Handler chuyển nguyên input cho `SchemaService.createRelation` — cùng service với `POST /relations` |
| `create_intent` | `createIntent` | governed | `IntentService.create` parse lại bằng `intentInputSchema`, như REST |
| `update_translation` | `updateTranslation` | governed | Cùng câu lệnh update theo `site_id` như `PATCH /translations/:id` |
| `create_webhook` | `createWebhook` | governed | Cùng insert như `POST /webhooks`; default của route trùng default của cột |
| `update_webhook` | `updateWebhook` | governed | Cùng update theo `site_id` như `PATCH /webhooks/:id` |
| `delete_cdc_subscription` | `deleteCdcSubscription` | governed (rename `id` → `subscriptionId`) | Cùng `SubscriptionService.remove`; khác biệt đã biết ghi ở dưới |
| `create_cdc_subscription` | `createCdcSubscription` | `contract-narrower-than-tool` | Tool quảng bá `payload_mode`, handler không chuyển tiếp nó |
| `create_flow` | `createFlow` | `skill-weaker-than-rest` | Handler bỏ qua gate graph cho flow `active`, gate cron của trigger `schedule`, và không đặt `nextRunAt` |
| `install_extension` | `installExtension` | `skill-weaker-than-rest` | Handler bỏ qua kiểm chữ ký bundle, kiểm namespace `lumibase-*` và probe quyền `extensions:*` theo từng hành động |
| `update_extension` | `updateExtension` | `skill-weaker-than-rest` | Handler bỏ qua probe quyền theo hành động, việc từ chối bật extension official chưa xác minh, evict cache sandbox và đồng bộ subscription CDC |

Cả mười skill đều đã có schema canonical, nên trên HTTP MCP chúng được validate ngay — kể cả bốn tool vẫn ở REST trên stdio. Ba schema update (`updateWebhook`, `updateTranslation`, `updateExtension`) còn đóng một lỗ cụ thể: handler đưa patch thẳng vào `.set()`, nên trước khi có `.strict()` một key như `siteId` (với extension còn có `isOfficial`, `verifiedAt`) được chuyển nguyên vào câu lệnh update.

Cả mười skill cũng đều là control-plane (cờ `dangerous`, capability `schema:*` ghi, hoặc tiền tố `delete`), nên route không làm yếu HITL: trên `POST /api/v1/mcp` chúng cần admin principal, và dưới autopilot thì park approval thay vì chạy.

Hai khác biệt quan sát được giữa đường governed và REST của tool đã route:

- `delete_cdc_subscription`: harness dựng `SubscriptionService` không có `cache`/`audit`, nên dòng audit log `cdc_subscription_deleted` và việc xoá cache cờ feed của REST không xảy ra. Run, tool call và approval ghi lại việc xoá; cache cờ tự hết hạn theo TTL.
- `update_webhook`: harness chỉ ghi các field người gọi gửi, còn `PATCH /webhooks/:id` hiện áp lại default của route cho field vắng mặt (backlog B86).

**`UNGOVERNED_MUTATIONS`** — vẫn gọi REST, kèm lý do từng tool:

| Lý do | Nghĩa |
|---|---|
| `contract-narrower-than-tool` | Skill có, nhưng contract canonical hẹp hơn surface tool đang quảng bá. Route vào sẽ **từ chối** đúng những arg caller đang gửi; rụng im lặng lại chính là lớp lỗi đang sửa. Ví dụ `create_collection` thừa 16 property |
| `skill-weaker-than-rest` | Skill và contract canonical nhận đủ arg tool quảng bá, nhưng handler bỏ qua một bước kiểm tra mà route REST có. Route vào sẽ thêm HITL nhưng bỏ bước kiểm tra đó, nên tool ở lại REST cho tới khi handler mang đủ |
| `no-canonical-contract` | Skill có, chưa có schema canonical nên không có gì để validate. Hiện **trống** — mười tool từng thuộc nhóm này đã có schema (bảng trên) |
| `no-skill` | Không có skill tương ứng — không có đích để route |

Đây là **khoảng trống được khai báo**, không phải khoảng trống bị che. Tripwire `S16` fail nếu một mutation tool không thuộc bảng nào, nên tập này không thể tự lớn lên trong im lặng.

### Chế độ hoạt động

`LUMIBASE_MCP_GOVERNED`:

| Giá trị | Hành vi |
|---|---|
| `auto` (mặc định) | Probe một lần. Có governance thì dùng; không có thì fallback REST kèm **cảnh báo stderr một lần**. Mutation chưa ánh xạ vẫn đi REST |
| `on` / `true` / `1` | **Từ chối** thay vì fallback — và từ chối luôn mọi mutation không có ánh xạ governed. Đây là giá trị đúng cho deployment bắt buộc governance |
| `off` / `false` / `0` | Giữ hành vi trước #454 |

Mặc định là `auto` vì `contentOs.mcp` cũng default **off** — mặc định `on` sẽ phá mọi cài đặt hiện có ngay khi upgrade.

`auto` là tiện lợi, **không phải** một tính chất bảo mật: fallback nó thực hiện được nói ra, nhưng deployment không được phép thực thi write ungoverned thì phải đặt `on`. Lý do: một fallback kích hoạt đúng lúc governance không khả dụng chính là một đường vòng qua governance.

**Mode `on` từ chối cả mutation chưa ánh xạ.** Khai một khoảng trống trong `UNGOVERNED_MUTATIONS` là mô tả nó, không phải đóng nó. Trước đây wrapper đăng ký chỉ thay handler khi có ánh xạ governed, nên ở `on` — đúng cái cấu hình tồn tại để "không bao giờ thực thi một write ungoverned" — 27 tool được ánh xạ thì có governance, còn các mutation khác vẫn đi thẳng REST. `update_collection` gọi tới `PATCH /collections/:name` và báo thành công với **không một** JSON-RPC call nào.

Ở `on`, một mutation không có ánh xạ nay trả về lỗi kèm lý do, và **không có REST call nào được phát ra** — lời từ chối thay thế lời gọi chứ không đi sau nó. Mutation không nằm ở cả hai bảng cũng bị từ chối, nên một tool được thêm mà chưa có quyết định governance sẽ fail an toàn ở runtime dù CI có bỏ sót. Tool chỉ-đọc không bị ảnh hưởng: từ chối chúng làm hỏng transport mà không đổi lấy an toàn nào. Việc phân loại dùng `isMutationTool` trong `governed.ts`, chính hàm mà tripwire inventory dùng — một định nghĩa, nên gate và tripwire không thể nói khác nhau.

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
