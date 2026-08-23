---
version: 1
lastUpdated: 2026-08-02T19:02:34.419Z
sourceLang: en
translatedFrom: en
sourceHash: 82398215345c6e2e
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:02:34.419Z
codeVerifiedHash: 82398215345c6e2e
codeVerifiedClaims: 6
---

# Tài liệu AI Skills phục vụ Phát triển LumiBase

Tài liệu này chứa các prompt AI và kỹ năng (skills) được cấu trúc hóa nhằm hướng dẫn phát triển LumiBase với sự hỗ trợ của AI. Sao chép các phần này vào system prompt của trợ lý AI hoặc sử dụng làm tài liệu tham khảo khi làm việc với các trợ lý lập trình AI.

---

## 1. Định hướng Dự án: Bản sắc Cốt lõi của LumiBase

**Mục tiêu:** Giúp AI hiểu được bản chất và tầm nhìn của dự án.

* **Tên dự án:** LumiBase.
* **Triết lý:** "Lấy cảm hứng từ Directus, Edge-native, Sẵn sàng cho Production".
* **Vấn đề giải quyết:** Khắc phục các điểm yếu của Directus về Multi-tenancy, xung đột ID, quản lý cache kém, và khó khăn trong CI/CD.
* **Kiến trúc cốt lõi:** Headless CMS hỗ trợ quản lý dữ liệu động kết hợp với cấu hình UI (tư duy Page-builder) trả về trong một cuộc gọi API duy nhất.

---

## 2. Định nghĩa Định hình Công nghệ (Kỹ năng "Cứng")

**Mục tiêu:** Quy định nghiêm ngặt các công nghệ AI được phép sử dụng.

* **Runtime:** Node.js (Tương thích Edge, ưu tiên Hono.js hoặc ElysiaJS).
* **Cơ sở dữ liệu:** PostgreSQL (Hybrid RDBMS + JSONB).
* **Hạ tầng:** Cloudflare Stack (Workers, R2, Hyperdrive, KV).
* **Xác thực:** Logto (OIDC, Multi-tenancy).
* **Giao tiếp:** Resend (Email), Webhooks (Event-driven).
* **Tham chiếu Frontend:** Next.js (App Router, SSR), TailwindCSS, Shadcn UI.

---

## 3. AI Skills / System Prompts

Sao chép các phần sau vào system prompt của trợ lý AI hoặc file README dự án để đảm bảo AI luôn tuân thủ các nguyên tắc này:

### Skill 1: Kiến trúc sư CSDL & Migration

> **Nhiệm vụ:** Thiết kế schema và cơ chế đồng bộ dữ liệu.
> * **Quy tắc ID:** Tuyệt đối không dùng Serial/Auto-increment. Sử dụng NanoID (ngắn, thân thiện URL) hoặc UUIDv7.
> * **Multi-tenancy:** Mọi bảng bắt buộc phải có `site_id` để phân tách dữ liệu cấp dòng (Row-Level) tuyệt đối.
> * **Config-as-Code:** Xây dựng mô-đun xuất/nhập cấu hình (Vai trò, Quyền hạn, Bộ sưu tập) ra các file YAML/JSON để hỗ trợ GitOps.

### Skill 2: Chuyên gia Edge & Caching

> **Nhiệm vụ:** Tối ưu hóa hiệu năng trên Cloudflare.
> * **Cache Tagging:** Triển khai hủy cache theo Tag trong Redis/Cloudflare KV. Khi một bản ghi cập nhật, hủy tất cả cache-key liên quan.
> * **An toàn File:** Xây dựng middleware kiểm tra File Signature (Magic Numbers) trước khi tải lên Cloudflare R2, không tin tưởng phần mở rộng file từ phía client.

### Skill 3: Logic Hydration Dữ liệu Hợp nhất

> **Nhiệm vụ:** Xử lý luồng dữ liệu "1-roundtrip".
> * **Logic:** Thiết kế API `/deliver/{page_slug}` tổng hợp Cấu hình Trang (từ bảng `pages`) và Dữ liệu (từ các `collections` liên quan) thành một JSON duy nhất.
> * **Sẵn sàng cho SEO:** Đảm bảo cấu trúc JSON trả về có đủ thông tin để Next.js SSR dựng HTML hoàn chỉnh mà không cần gọi API bổ sung.

### Skill 4: Cầu nối Thành phần UI/UX

> **Nhiệm vụ:** Kết nối CMS với TailwindCSS/Next.js.
> * **Mẫu thiết kế:** Sử dụng Class Variance Authority (CVA) để ánh xạ "Intents" của CMS thành các class Tailwind thực tế.
> * **Nội dung Phong phú:** Sử dụng `html-react-parser` để xử lý HTML động từ CMS, đảm bảo chuyển đổi các thẻ `<a>` thành Next.js `<Link>` và thẻ `<img>` thành Next.js `<Image>`.

---

## 3b. Runtime AI Skill Registry (MCP & Governed Harness)

> Đây là các kỹ năng **runtime** mà agent có thể thực thi — khác với các prompt cho nhà phát triển ở trên. Nguồn sự thật: `apps/cms/src/services/ai-harness.ts` (`buildCoreSkills`) được phản chiếu dưới dạng metadata trong `packages/ai-skills/src/skills.ts`. Một test đồng bộ registry xác nhận hai bên luôn khớp nhau.

Các kỹ năng chạy qua **điểm cuối được kiểm soát** `POST /api/v1/mcp` (được bảo vệ bởi cờ per-site `contentOs.mcp`) thông qua `AISecureHarness.execute`, kế thừa mọi cơ chế bảo vệ: kill switch → kiểm tra capability → mức tự trị L0–L4 → cửa sổ phủ quyết (veto window) → phê duyệt HITL → kiểm toán (audit).

**Phân loại rủi ro.** Một kỹ năng là nguy hiểm (được kiểm soát bởi HITL/tự trị) khi nó (a) đặt cờ `dangerous`, (b) yêu cầu capability thay đổi dữ liệu `schema:*`, hoặc (c) có tên bắt đầu bằng `delete*`. Thao tác CRUD mục lưu trữ (Item) vẫn an toàn. Các kỹ năng không thể đảo ngược (`deleteCollection`, `deleteField`, `deleteRole`, `deletePolicy`, `deleteRelation`, `revokeApiKey`, `removeUser`) bị giới hạn cứng ở mức tự trị **L2** và không bao giờ chạy tự động hoàn toàn.

| Skill | Capability | Risk |
|-------|-----------|------|
| `listCollections` / `listItems` | `schema:read` / `items:read` | safe |
| `createCollection` / `createField` | `schema:create` / `schema:update` | dangerous |
| `deleteCollection` / `deleteField` | `schema:delete` | dangerous · irreversible |
| `createItem` / `updateItem` / `deleteItem` | `items:write`/`update`/`delete` | safe (delete via name) |
| `listVersions` / `compareVersion` | `items:read` | safe |
| `createVersion` / `updateVersion` / `deleteVersion` / `promoteVersion` | `items:write` | dangerous — write-guarded; `promoteVersion` applies a branch to main (revision-protected, so not hard-capped like schema drops) |
| `aiSuggestField` · `aiContentAssist` · `generate*` | `schema:read` / `items:*` | safe |
| `listRelations` | `schema:read` | safe |
| `createRelation` / `deleteRelation` | `schema:create` / `schema:delete` | dangerous · (delete) irreversible |
| `listRoles` / `listPolicies` | `access:read` | safe |
| `createRole` / `createPolicy` | `access:create` | dangerous |
| `deleteRole` / `deletePolicy` | `access:delete` | dangerous · irreversible |
| `listIntents` / `createIntent` / `deleteIntent` | `intents:read` / `intents:write` | safe / dangerous |
| `listFlows` / `createFlow` / `deleteFlow` / `runFlow` | `flows:read` / `flows:write` / `flows:run` | safe / dangerous |
| `listApiKeys` / `createApiKey` / `rotateApiKey` / `revokeApiKey` | `api-keys:read`/`create`/`write`/`delete` | safe / dangerous (`revoke` irreversible) |
| `listUsers` / `inviteUser` / `updateUser` / `removeUser` | `users:read`/`write`/`delete` | safe / dangerous (`remove` irreversible) |
| `listTeams` / `createTeam` / `deleteTeam` / `addTeamMember` / `removeTeamMember` | `teams:read`/`write`/`delete` | safe / dangerous |
| `listSettings`/`listTranslations`/`listWebhooks` + their create/update/delete | `config:read`/`write`/`delete` | safe / dangerous |
| `listExtensions` / `installExtension` / `updateExtension` / `uninstallExtension` | `extensions:read`/`write`/`delete` | safe / dangerous |
| `listDeploymentTargets` / `listDeployments` / `getDeploymentStatus` / `triggerDeployment` | `deployments:read` / `deployments:write` | safe / dangerous (`trigger` gated by HITL below autopilot) |
| `listCdcSubscriptions` / `getCdcSubscriptionStatus` / `createCdcSubscription` / `replayCdcSubscription` / `deleteCdcSubscription` | `cdc:manage` | reads safe; `create`/`replay`/`delete` are control-plane → HITL below autopilot. `create`/`replay` carry an explicit `dangerous` flag, `delete` via the `delete` name prefix — so the agent/MCP path matches the admin-only `/api/v1/cdc` REST surface |

**Tên bộ sưu tập dành riêng.** `createCollection` (và mọi thao tác đổi tên qua `updateCollection`) từ chối các tên bắt đầu bằng tiền tố `lumibase_`, vốn thuộc sở hữu của nền tảng (bảng đồng bộ CDC/Firebase, cấu hình nội bộ). Cơ chế bảo vệ nằm trong `SchemaService.ensureName`, áp dụng đồng nhất cho AI harness, các route builder/Studio và bất kỳ caller nào khác; vi phạm sẽ trả về `RESERVED_NAME` (HTTP 422).

**MCP server độc lập (`@lumibase/mcp-server`, `lumibase-mcp`).** Một stdio server riêng biệt bao bọc REST API thành ~105 MCP tool bao phủ toàn bộ phạm vi vận hành nội dung: nội dung, RBAC, người dùng/nhóm, intents/flows (bao gồm `get_flow_run`), webhooks, bản dịch, bộ nhớ dịch (bao gồm `update_tm`/`delete_tm`), tìm kiếm, media + `list_transform_presets`, phân giải preset (`get_effective_preset`/`list_preset_bookmarks`), quy trình biên tập (`list_reviews`/`submit_review`/`approve_content`/`reject_content`), phát hành nội dung (CRUD + `publish_release`), triển khai chỉ đọc (`list_deployments`/`get_deployment_logs` — kích hoạt vẫn được kiểm soát), liên kết chia sẻ (`create_share`/`revoke_share`), `get_site`, vận hành, sao lưu/khôi phục, materialize, tiện ích mở rộng, marketplace, và **thống kê** chỉ đọc (`list_dashboards`/`run_panel`/`query_insights`). Đây là đường truyền không kiểm soát — RBAC/tenancy được thực thi ở phía server cho bearer token. Các tool có tính phá hủy yêu cầu `confirm: true`. Xem `docs/en/agent-setup/`.

**Cố ý không có trên MCP.** Các tính năng này bị loại trừ theo thiết kế chứ không phải bỏ sót: realtime/SSE (`/realtime` — không phải request/response; poll qua `cdc_events_read`), URL phân phối media đã ký (được dựng ở edge với secret của server — không có điểm cuối REST), tải lên/tải xuống nhị phân (`/files`, `/uploads` — stream ở edge), quản trị an toàn/GDPR (`/admin/encryption`, `/admin/sar`, `/admin/erasure`, `/retention`, `/scim-tokens`), xác thực/phiên làm việc và tự phục vụ theo principal (`/auth`, `/me/*`), và công cụ dev/hạ tầng (`/typegen`, `/domains`, `/integrations/git`, `/firebase-sync`, `/push`).

> **Phiên bản nội dung cố ý không nằm trong server độc lập.** `promoteVersion` thay đổi main và phải chạy qua HITL, điều mà đường truyền stdio không thể thực thi — do đó versioning chỉ được cung cấp dưới dạng các kỹ năng harness có kiểm soát (ở trên), truy cập qua `POST /api/v1/mcp`. Xem [`docs/en/mcp/`](mcp/index.md) để biết chi tiết về việc chia thành hai bề mặt và lộ trình triển khai theo giai đoạn.

---

## 4. Đóng gói cho AI

Để giúp AI có thể thực sự bắt đầu "lập trình", hãy tổ chức thư mục dự án của bạn như sau:

1. **`/docs/specs`**: Chứa các file Markdown chi tiết cho từng tính năng (Auth, File, Caching).
2. **`/docs/prompts`**: Chứa các "Skills" được liệt kê ở trên.
3. **`/schema`**: Chứa các file SQL ban đầu hoặc các file định nghĩa Prisma/Drizzle.
4. **`.cursorrules` (Nếu dùng Cursor):** Dán toàn bộ "Định hình Công nghệ" và "Skills" vào đây. AI sẽ tự động tuân thủ mỗi khi bạn viết code.

---

## 5. Sử dụng với các Trợ lý Lập trình AI

Khi làm việc với các trợ lý lập trình AI (Cursor, GitHub Copilot, Claude, v.v.), hãy cung cấp bối cảnh sau:

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

## 6. Quyền lợi Tài trợ

Tài liệu AI Skills này là một phần của nội dung đặc quyền dành riêng cho GitHub Sponsors ở gói Hobby ($29/tháng) trở lên. Nhóm tài trợ sẽ nhận được:

- Tài liệu AI Skills đầy đủ kèm các prompt chi tiết
- Chiến lược marketing thực tế dành cho công cụ lập trình
- Kịch bản phát hành sản phẩm (launch playbooks)
- Khung bài bản để xây dựng cộng đồng
- Mẫu tiếp thị nội dung (content marketing templates)
- Các kỹ thuật tăng trưởng nhanh (growth hacking techniques)

[Become a Sponsor](https://github.com/sponsors/khuepm) để mở khóa các tài nguyên này và tăng tốc phát triển với sự hỗ trợ của AI.
