---
version: 1
lastUpdated: 2026-08-04T22:04:09.568Z
sourceLang: en
translatedFrom: en
sourceHash: 82398215345c6e2e
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-04T22:04:09.568Z
codeVerifiedHash: 82398215345c6e2e
codeVerifiedClaims: 6
---

# Tài liệu AI Skills cho việc phát triển LumiBase

Tài liệu này chứa các AI prompt và skill có cấu trúc, dùng để định hướng việc phát triển LumiBase với sự hỗ trợ của AI. Copy các mục dưới đây vào system prompt của AI assistant, hoặc dùng làm tài liệu tham chiếu khi làm việc với AI coding assistant.

---

## 1. Bản thiết kế dự án: bản sắc cốt lõi của LumiBase

**Mục tiêu:** Giúp AI hiểu bản chất và tầm nhìn của dự án.

* **Tên dự án:** LumiBase.
* **Triết lý:** "Directus-inspired, Edge-native, Production-ready".
* **Vấn đề cần giải:** Vượt qua các điểm yếu của Directus ở Multi-tenancy, ID collision, quản lý cache kém và khó khăn khi làm CI/CD.
* **Kiến trúc cốt lõi:** Headless CMS hỗ trợ quản lý dữ liệu động kết hợp cấu hình UI (tư duy Page-builder), trả về trong một lần gọi API duy nhất.

---

## 2. Định nghĩa technical stack (nhóm skill "cứng")

**Mục tiêu:** Định nghĩa chặt chẽ những công nghệ AI được phép dùng.

* **Runtime:** Node.js (tương thích Edge, ưu tiên Hono.js hoặc ElysiaJS).
* **Database:** PostgreSQL (Hybrid RDBMS + JSONB).
* **Hạ tầng:** Cloudflare Stack (Workers, R2, Hyperdrive, KV).
* **Authentication:** Logto (OIDC, Multi-tenancy).
* **Giao tiếp:** Resend (Email), Webhooks (Event-driven).
* **Frontend tham chiếu:** Next.js (App Router, SSR), TailwindCSS, Shadcn UI.

---

## 3. AI Skills / System Prompts

Copy các mục dưới đây vào system prompt của AI assistant hoặc README dự án để đảm bảo AI luôn tuân theo các nguyên tắc này:

### Skill 1: Database & Migration Architect

> **Nhiệm vụ:** Thiết kế schema và cơ chế đồng bộ dữ liệu.
> * **Quy tắc ID:** Tuyệt đối không dùng Serial/Auto-increment. Dùng NanoID (ngắn, thân thiện URL) hoặc UUIDv7.
> * **Multi-tenancy:** Mọi bảng đều phải có `site_id` để tách dữ liệu tuyệt đối ở mức Row-Level.
> * **Config-as-Code:** Xây module export/import cấu hình (Roles, Permissions, Collections) ra file YAML/JSON để hỗ trợ GitOps.

### Skill 2: Edge & Caching Specialist

> **Nhiệm vụ:** Tối ưu hiệu năng trên Cloudflare.
> * **Cache Tagging:** Triển khai cache invalidation theo Tag trong Redis/Cloudflare KV. Khi một record được cập nhật, invalidate mọi cache-key liên quan.
> * **File Security:** Xây middleware kiểm tra File Signature (Magic Numbers) trước khi upload lên Cloudflare R2, không tin phần mở rộng file do client gửi.

### Skill 3: Unified Data Hydration Logic

> **Nhiệm vụ:** Xử lý luồng dữ liệu "1-roundtrip".
> * **Logic:** Thiết kế API `/deliver/{page_slug}` gộp Page Config (từ bảng `pages`) và Data (từ các `collections` liên quan) thành một JSON duy nhất.
> * **SEO-Ready:** Đảm bảo cấu trúc JSON trả về có đủ thông tin để Next.js SSR render ra HTML hoàn chỉnh mà không cần gọi API thêm.

### Skill 4: UI/UX Component Bridge

> **Nhiệm vụ:** Nối CMS với TailwindCSS/Next.js.
> * **Pattern:** Dùng Class Variance Authority (CVA) để map "Intents" của CMS sang class Tailwind thực tế.
> * **Rich Content:** Dùng `html-react-parser` để xử lý HTML động từ CMS, đảm bảo chuyển thẻ `<a>` thành `<Link>` của Next.js và thẻ `<img>` thành `<Image>` của Next.js.

---

## 3b. Registry AI skill lúc runtime (MCP & governed harness)

> Đây là các skill **runtime** mà agent gọi được — khác với các prompt cho developer ở trên. Nguồn sự thật: `apps/cms/src/services/ai-harness.ts` (`buildCoreSkills`), được mirror thành metadata trong `packages/ai-skills/src/skills.ts`. Một test registry-sync đảm bảo hai bên luôn khớp nhau.

Skill chạy qua **governed endpoint** `POST /api/v1/mcp` (gated bởi cờ `contentOs.mcp` theo từng site) thông qua `AISecureHarness.execute`, thừa hưởng mọi guard: kill switch → capability check → autonomy L0–L4 → veto window → HITL approval → audit.

**Phân loại rủi ro.** Một skill là dangerous (bị gate bởi HITL/autonomy) khi nó (a) bật cờ `dangerous`, (b) yêu cầu một capability `schema:*` có tính mutating, hoặc (c) có tên dạng `delete*`. Item CRUD vẫn là non-dangerous. Các skill không thể hoàn tác (`deleteCollection`, `deleteField`, `deleteRole`, `deletePolicy`, `deleteRelation`, `revokeApiKey`, `removeUser`) bị chặn cứng ở autonomy **L2** và không bao giờ chạy autopilot.

| Skill | Capability | Rủi ro |
|-------|-----------|------|
| `listCollections` / `listItems` | `schema:read` / `items:read` | safe |
| `createCollection` / `createField` | `schema:create` / `schema:update` | dangerous |
| `deleteCollection` / `deleteField` | `schema:delete` | dangerous · không hoàn tác |
| `createItem` / `updateItem` / `deleteItem` | `items:write`/`update`/`delete` | safe (delete theo tên) |
| `listVersions` / `compareVersion` | `items:read` | safe |
| `createVersion` / `updateVersion` / `deleteVersion` / `promoteVersion` | `items:write` | dangerous — bị guard ở đường write; `promoteVersion` áp một branch vào main (được revision bảo vệ nên không bị chặn cứng như các lệnh drop schema) |
| `aiSuggestField` · `aiContentAssist` · `generate*` | `schema:read` / `items:*` | safe |
| `listRelations` | `schema:read` | safe |
| `createRelation` / `deleteRelation` | `schema:create` / `schema:delete` | dangerous · (delete) không hoàn tác |
| `listRoles` / `listPolicies` | `access:read` | safe |
| `createRole` / `createPolicy` | `access:create` | dangerous |
| `deleteRole` / `deletePolicy` | `access:delete` | dangerous · không hoàn tác |
| `listIntents` / `createIntent` / `deleteIntent` | `intents:read` / `intents:write` | safe / dangerous |
| `listFlows` / `createFlow` / `deleteFlow` / `runFlow` | `flows:read` / `flows:write` / `flows:run` | safe / dangerous |
| `listApiKeys` / `createApiKey` / `rotateApiKey` / `revokeApiKey` | `api-keys:read`/`create`/`write`/`delete` | safe / dangerous (`revoke` không hoàn tác) |
| `listUsers` / `inviteUser` / `updateUser` / `removeUser` | `users:read`/`write`/`delete` | safe / dangerous (`remove` không hoàn tác) |
| `listTeams` / `createTeam` / `deleteTeam` / `addTeamMember` / `removeTeamMember` | `teams:read`/`write`/`delete` | safe / dangerous |
| `listSettings`/`listTranslations`/`listWebhooks` + create/update/delete của chúng | `config:read`/`write`/`delete` | safe / dangerous |
| `listExtensions` / `installExtension` / `updateExtension` / `uninstallExtension` | `extensions:read`/`write`/`delete` | safe / dangerous |
| `listDeploymentTargets` / `listDeployments` / `getDeploymentStatus` / `triggerDeployment` | `deployments:read` / `deployments:write` | safe / dangerous (`trigger` bị HITL gate khi dưới autopilot) |
| `listCdcSubscriptions` / `getCdcSubscriptionStatus` / `createCdcSubscription` / `replayCdcSubscription` / `deleteCdcSubscription` | `cdc:manage` | các lệnh đọc là safe; `create`/`replay`/`delete` thuộc control-plane → HITL khi dưới autopilot. `create`/`replay` mang cờ `dangerous` tường minh, `delete` qua tiền tố tên `delete` — nhờ vậy đường agent/MCP khớp với surface REST `/api/v1/cdc` chỉ dành cho admin |

**Tên collection được giữ riêng.** `createCollection` (và mọi lần rename qua `updateCollection`) từ chối các tên bắt đầu bằng tiền tố `lumibase_`, vốn thuộc quyền của nền tảng (bảng CDC/Firebase sync, config nội bộ). Guard nằm ở `SchemaService.ensureName` nên nó áp dụng đồng nhất cho AI harness, các route builder/Studio, và mọi caller khác; vi phạm sẽ báo `RESERVED_NAME` (HTTP 422).

**MCP server độc lập (`@lumibase/mcp-server`, `lumibase-mcp`).** Một server stdio riêng bọc REST API thành khoảng 105 MCP tool, phủ toàn bộ surface content-operations: content, RBAC, users/teams, intents/flows (gồm `get_flow_run`), webhooks, translations, translation-memory (gồm `update_tm`/`delete_tm`), search, media + `list_transform_presets`, phân giải preset (`get_effective_preset`/`list_preset_bookmarks`), workflow biên tập (`list_reviews`/`submit_review`/`approve_content`/`reject_content`), content release (CRUD + `publish_release`), deployment chỉ-đọc (`list_deployments`/`get_deployment_logs` — việc trigger vẫn thuộc diện governed), share link (`create_share`/`revoke_share`), `get_site`, ops, backup/restore, materialize, extensions, marketplace, và **insights** chỉ-đọc (`list_dashboards`/`run_panel`/`query_insights`). Nó là một passthrough ungoverned — RBAC/tenancy được enforce ở phía server theo bearer token. Các tool phá huỷ yêu cầu `confirm: true`. Xem `docs/en/agent-setup/`.

**Cố tình không đưa lên MCP.** Những phần sau bị loại trừ có chủ ý, không phải bỏ sót: realtime/SSE (`/realtime` — không theo mô hình request/response; hãy poll qua `cdc_events_read`), URL delivery media có ký (được dựng ở edge bằng server secret — không có REST endpoint), upload/download binary (`/files`, `/uploads` — stream ở edge), quản trị security/GDPR (`/admin/encryption`, `/admin/sar`, `/admin/erasure`, `/retention`, `/scim-tokens`), auth/session và self-service theo từng principal (`/auth`, `/me/*`), và tooling dev/hạ tầng (`/typegen`, `/domains`, `/integrations/git`, `/firebase-sync`, `/push`).

> **Content version cố ý không có trong server độc lập.** `promoteVersion` mutate main và buộc phải đi qua HITL, điều mà passthrough stdio không enforce được — nên versioning chỉ được expose dưới dạng governed harness skill (ở trên), truy cập qua `POST /api/v1/mcp`. Xem [`docs/en/mcp/`](mcp/index.md) để hiểu cách tách hai surface và lộ trình rollout theo từng pha.

---

## 4. Đóng gói cho AI

Để AI thực sự bắt đầu "code" được, hãy tổ chức thư mục dự án như sau:

1. **`/docs/specs`**: Chứa các file Markdown chi tiết cho từng feature (Auth, File, Caching).
2. **`/docs/prompts`**: Chứa các "Skill" liệt kê ở trên.
3. **`/schema`**: Chứa các file SQL khởi tạo hoặc file định nghĩa Prisma/Drizzle.
4. **`.cursorrules` (nếu dùng Cursor):** Dán toàn bộ "Technical Stack" và "Skills" vào đây. AI sẽ tự động tuân theo mỗi lần bạn viết code.

---

## 5. Dùng với AI coding assistant

Khi làm việc với AI coding assistant (Cursor, GitHub Copilot, Claude, v.v.), hãy cung cấp context sau:

```
You are working on LumiBase, an Edge-native Headless CMS. Follow these strict guidelines:

- Use NanoID or UUIDv7 for all IDs (no auto-increment)
- Every table must have site_id for multi-tenancy
- Build for Cloudflare Workers edge deployment
- Use Hono.js for backend APIs
- Implement cache tagging for invalidation
- Use Class Variance Authority for Tailwind mapping
- Design single-roundtrip APIs for optimal performance
- Follow the Technical Stack defined in docs/ai-skills.md

Refer to docs/ai-skills.md for detailed skill definitions and patterns.
```

---

## 6. Quyền lợi tài trợ

Tài liệu AI Skills này là một phần nội dung độc quyền dành cho GitHub Sponsors từ bậc Hobby ($29/tháng) trở lên. Người tài trợ nhận được:

- Tài liệu AI Skills đầy đủ kèm prompt chi tiết
- Chiến lược marketing thực tế cho sản phẩm dành cho developer
- Playbook ra mắt sản phẩm
- Bộ khung xây dựng cộng đồng
- Template content marketing
- Các kỹ thuật growth hacking

[Trở thành Sponsor](https://github.com/sponsors/khuepm) để mở các tài nguyên này và tăng tốc phát triển cùng sự hỗ trợ của AI.
