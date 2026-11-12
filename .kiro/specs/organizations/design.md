# Design — Organizations (organization plane)

> Status: **Implemented**. Thực thi [ADR-013](../../../docs/en/architecture/decisions/adr-013-organization-plane.md). Phase 1–4 đã merge vào `epic/organizations`; Phase 5 chốt tài liệu, cấu hình và kiểm chứng theo issue #640.

## 0. Nguyên tắc

1. Credential phân loại theo phạm vi: `lbk_` không thể nhận quyền organization từ policy site; `lbo_` có organization parent thật.
2. Personal_Org được tạo ngầm trong setup. Organization Settings luôn hiện cho owner/admin, kể cả một org; chỉ ẩn switcher khi có một org.
3. Dùng chung provisioning, tạo/hash token, audit và `ai_approvals`; không dùng site mặc định giả để chứa thao tác organization.
4. "Control plane" cũ vẫn là quản trị site. Organization có guard và ma trận quyền riêng.

## 1. Schema và migration

Nguồn: `packages/database/src/schema/core.ts`, `access.ts`, `ai.ts`.

| Bảng | Contract |
|---|---|
| `lumibase_organizations` | ID nanoid, slug duy nhất, name, settings JSONB mặc định `{}`, timestamps |
| `lumibase_organization_members` | PK `(user_id, organization_id)`, FK cascade, role CHECK `owner/admin/billing/member` |
| `lumibase_sites` | `organization_id NOT NULL`, FK tới organization với delete RESTRICT |
| `lumibase_api_keys` | `scope` site/organization; đúng một parent tương ứng; site key cũ giữ scope site |
| `lumibase_ai_approvals` | Đúng một parent site hoặc organization; org approval phải có requester; result là human receipt |

### Migration viết tay

- `packages/database/drizzle/0024_organizations.sql`: tạo bảng, thêm parent site nullable, backfill mọi site cũ vào org `default`, thêm bootstrap owner nếu có, áp NOT NULL và CHECK scope key. SQL backfill tạo ID ngẫu nhiên 21 ký tự; không dùng serial. Install chưa có bootstrap có thể có org backfill chưa có member; setup sau đó thêm bootstrap owner.
- `packages/database/drizzle/0025_organization_approvals.sql`: parent organization/requester/result cho approval, nullable site parent và CHECK XOR; không thay đổi parent của approval site cũ.
- Journal được sửa tay. Cả hai migration đã được chạy trên PostgreSQL thật; 0024 có ma trận 0/1/3 site × có/không bootstrap và chạy lại; 0025 có kiểm chứng chạy lại, giữ dữ liệu cũ và từ chối parent không hợp lệ.
- Số migration được đối soát mọi branch/PR mở trước merge. Không rollback tự động; khôi phục backup trước nâng cấp nếu cần quay lại.

### RLS

`createOrganizationScopedSql` / `organizationScopedDbFor` dùng `lumibase.organization_id`; guard xác minh membership trước khi chuyển request DB sang org scope. Bảng org và approval có cặp policy restrictive/permissive để không bị một policy permissive khác mở rộng. Approval site lọc theo `app.site_id`; approval organization lọc theo organization scope. Test dùng role PostgreSQL không có BYPASSRLS.

## 2. Credential và quyền

`packages/contracts/src/token-prefix.ts` cung cấp `classifyTokenPrefix`; `packages/contracts/src/org-permissions.ts` cung cấp `canOrg`, dùng chung CMS, MCP và Studio. `apps/cms/src/services/api-key-token.ts` mint/hash `lbo_`.

| Role | Quyền |
|---|---|
| owner | Tất cả chín Org_Action |
| admin | read, sites:create, members:manage, keys:manage, settings:write |
| billing | read, billing:manage (placeholder; không có billing thật) |
| member | read |

## 3. Guard và kế thừa

Org key luôn là admin, không thể là owner. Role/policy site không cấp Org_Action. `withOrganizationAccessGuard` kiểm tra live member hoặc org của key; thiếu membership hay sai resource parent trả 404. Tạo/đổi/xóa owner chỉ dành cho owner; mutation owner dùng khóa organization để giữ invariant owner cuối.

`resolveSiteAdminAccess` trong `apps/cms/src/services/site-admin-access.ts` là điểm dùng chung cho quyền site admin và provenance `via`. Owner/admin organization kế thừa administrator trên site thuộc org; billing/member không kế thừa. `EffectiveCapabilityService` có caller class `organization_api_key` và cấp bundle administrator chỉ sau khi xác minh site thuộc org của key.

### Auth matrix

| Credential | Organization plane | Site plane |
|---|---|---|
| `lbk_`, `lbk_pub_`, frontend session | 403 `ORGANIZATION_FORBIDDEN`, audit reason `site_scoped_credential_on_org_plane` | quyền site hiện có |
| `lbo_` | org guard, admin cố định | phải có `X-Lumi-Site`, kiểm tra parent; sai org → 403 `SITE_NOT_IN_ORGANIZATION` |
| Staff / Studio user | membership organization hiện tại | membership site hoặc kế thừa owner/admin organization |

Login và refresh kiểm tra quyền organization hiện tại, kể cả khi thiếu `user_sites` hoặc có role trực tiếp yếu hơn. Gỡ quyền kế thừa chặn renewal nếu không còn direct grant; direct frontend role còn lại chỉ nhận frontend audience. Studio giữ site gốc của refresh family khi chọn site nội dung khác. Không đổi định dạng session hay token-store.

## 4. API

`apps/cms/src/routes/orgs.ts` mount trong API chain hiện có; tenant middleware nhận diện org path không cần `X-Lumi-Site`. Organization guard không dùng `CONTROL_PLANE_PATHS` của site. API reference đầy đủ ở `docs/en/api/hono-api-spec.md` và bản VI.

- Org CRUD: tạo chỉ cho bootstrap operator hoặc Studio user với `LUMIBASE_ALLOW_ORG_SIGNUP=true`. Caller thành owner. PATCH slug chỉ cho owner; slug `default` dùng lại được sau khi đổi.
- Sites: list/create/delete/transfer. Xóa cần `X-Confirm-Delete`; transfer cần cùng người là owner của cả nguồn và đích. Org phải không còn site trước khi bị xóa.
- Members: list/upsert/update/remove; body upsert chọn đúng một `userId` hoặc `email`. Account activation là luồng staff riêng; upsert không tự gửi email kích hoạt.
- Keys: list metadata/create/rotate/revoke dưới `/orgs/:orgId/keys`. Plaintext chỉ trả khi tạo/xoay. `/api/v1/api-keys` từ chối scope organization; org key được mint site key trong các site thuộc org.
- Approvals: list/detail/decide dưới `/orgs/:orgId/approvals`. Chỉ người dùng owner/admin được đọc/duyệt receipt, không cho API key.
- CORS cho phép `X-Confirm-Delete` từ origin đã cấu hình, kể cả bundled shell.

### 4.1 Provisioning dùng chung

`provisionSite(db, input)` trong `apps/cms/src/services/site-provisioning.ts` chạy trong transaction của caller: tạo site, upsert Administrator/Member, thêm creator membership nếu caller là user. `finalizeSiteProvisioning` sau commit reconcile official extensions và bỏ negative cache. Setup và REST/governed organization mutation dùng cùng service. Test đối chiếu role, membership, extension reconcile và cache.

### 4.2 Mã lỗi

`ORGANIZATION_FORBIDDEN`, `ORG_SIGNUP_DISABLED`, `SITE_NOT_IN_ORGANIZATION`, `ORGANIZATION_NOT_EMPTY`, `LAST_OWNER`, `SCOPE_NOT_ALLOWED` và các mã approval được mô tả trong API reference song ngữ.

## 5. MCP

### 5.1 Config và profile

Nguồn: `packages/mcp-server/src/client.ts`, `tools/index.ts`, `tools/organization.ts`, `governed.ts`; CMS `routes/mcp.ts`, `services/organization-harness.ts`, `services/mcp-service.ts`.

| Cấu hình | Tool |
|---|---|
| `lbk_` + site | Bộ site cũ; baseline 161 tên đã chụp trước Phase 3 |
| `lbo_` + site pin | Bộ site + `get_organization`, `list_sites` |
| `lbo_` không pin | Bộ site + tám tool organization; mỗi tool site bắt buộc đối số `site` |
| `LUMIBASE_READ_ONLY=true` | Lọc mọi mutation theo annotations |

### 5.2 Scoped calls và đăng ký

Pin chỉ ghim định tuyến/quảng bá tool của client, không đổi phạm vi credential ở server. Site header được tạo riêng mỗi lời gọi bằng AsyncLocalStorage/site override, không mutate header dùng chung giữa các lời gọi song song. Tool organization bỏ site header.

### 5.3 Tool organization

Tám tool organization: `get_organization`, `list_sites`, `create_site`, `delete_site`, `transfer_site`, `list_org_members`, `invite_org_member`, `create_org_key`. Chúng đi qua namespace HTTP `org:*`. Không có tool MCP xóa organization.

### 5.4 Gate và HITL

- `settings.contentOs.mcp.allowOrganizationTools` mặc định false; CMS env `LUMIBASE_MCP_ORG_TOOLS=off` ép tắt. Gate không mượn cờ MCP của một site khác.
- Mutation organization luôn tạo approval người dùng, độc lập chế độ governance site cũ. Không fallback REST, kể cả `LUMIBASE_MCP_GOVERNED=off`; `confirm` chỉ xác nhận ý định và không được dùng để approve.
- OrganizationHarness lưu org parent thật, requester user/key, arguments và approval ID UUIDv7; không cần có site. Run audit/result mang `organizationId` và run id.
- Decision khóa source/destination org theo thứ tự nhất quán, rồi khóa approval. Kiểm tra lại active requester, gate và human decider; domain mutation và receipt commit trong cùng transaction. Cùng decision trả receipt cũ; decision ngược trả 409. Xóa org đích không chặn reject hoặc replay receipt; chỉ pending execution cần đích còn tồn tại và cùng human owner.
- Owner-only delete/transfer/promotion dùng quyền owner của người duyệt; chuyển site còn kiểm tra owner của đích. API key không được quyết định hoặc đọc receipt. Token `create_org_key` chỉ có trong human receipt.
- Không có promotion L2+/veto/autopilot cho tool org trong ADR này.

## 6. Studio

`apps/studio/src/lib/organization-api.ts` được ghép vào client ở `lib/api.ts`; dùng cùng refresh và origin resolver, bỏ site header trên organization requests. `modules/organization/use-organizations.ts` dùng cache key có origin, session generation không bí mật và organization id.

- Switcher chỉ hiện với nhiều org; chọn org đổi trang cài đặt org. Sites → Open site chọn workspace nội dung. Tạo site chọn site mới.
- Organization Settings luôn hiện cho owner/admin, kể cả một org; direct read page vẫn tôn trọng `org:read`. General/Sites/Members/Keys/Approvals ẩn thao tác theo `canOrg`; API vẫn kiểm tra lại quyền thật.
- Đổi org remount form, bỏ token đang hiện. Đổi site hủy query, xóa cache, lưu active site rồi reload shell để không giữ local editor state của site cũ.
- Thao tác xóa/chuyển/xoay key/duyệt cần xác nhận tường minh; biên nhận token đóng được và có fallback copy thủ công.
- Có route root và custom admin path; active Settings item được normalize theo admin prefix. Trên mobile, switcher ở hàng riêng, menu Settings thu gọn được.
- Đã rà C1–C7: token-store/API origin/build path/dev port giữ nguyên, refresh body dùng site gốc, clipboard fallback, CORS header xác nhận và public health không đổi. Kiểm tra trình duyệt thực ở desktop, 390px và 320px.

## 7. Setup và triển khai

Setup tạo Personal_Org trước `__default__` trong cùng transaction với bootstrap membership, rồi gọi provisioning chung. Không có bước wizard mới.

Setup Impact Registry giữ một dòng ID 196 cho toàn bộ ADR. Hai env server: `LUMIBASE_ALLOW_ORG_SIGNUP` mặc định off; `LUMIBASE_MCP_ORG_TOOLS` mặc định on, chỉ ép tắt khi bằng `off`. Cấu hình mặc định có trong root/Docker/scaffold examples; các compose CMS truyền qua cả hai env. Org setting MCP vẫn mặc định false.

Setting instance và password login/refresh vẫn cần site. Sau khi xóa mọi site, chỉ credential organization hoặc Studio session còn hiệu lực mới tạo lại site được; nếu không còn credential phải khôi phục backup. Phục hồi human session không cần site là backlog B196, cùng thiết kế instance settings ngoài phạm vi ADR này. Hosted staff signup có thể gọi API tạo org sau Studio login khi signup flag bật; không biến public frontend signup thành Studio.

## 8. Kiểm chứng

- Auth matrix: `apps/cms/src/__tests__/auth-middleware-matrix.test.ts`.
- CRUD, ownership, credential boundaries, RLS: `apps/cms/src/routes/__tests__/orgs.db.integration.test.ts`.
- Provisioning: `apps/cms/src/services/__tests__/site-provisioning.test.ts` và real setup golden path.
- MCP/HITL/zero sites/revocation/atomic retry/secret isolation: `apps/cms/src/routes/__tests__/organization-mcp.db.integration.test.ts`.
- Login/refresh: `apps/cms/src/routes/__tests__/organization-session.db.integration.test.ts`.
- MCP profiles, old baseline, parallel site headers: `packages/mcp-server/src/__tests__/organization-profiles.test.ts`.
- Migration 0/1/3 × bootstrap và non-superuser RLS: `packages/database/src/__tests__/organizations-migration.integration.test.ts`; approval migration/RLS: `organization-approvals-migration.integration.test.ts` cùng thư mục.
- Studio permissions, cache clearing, receipts, real route trees: `apps/studio/src/modules/organization/__tests__`; transport/refresh: `apps/studio/src/lib/__tests__/api.test.ts`.
- Shell cross-origin preflight: `apps/cms/src/__tests__/organization-cors.test.ts`.
- CI full tests/typecheck/build, broad PostgreSQL suites, golden HTTP E2E; locale parity/verify/stamp/detect cho toàn bộ docs thay đổi. Baseline parity ngoài phạm vi theo B193 không được báo là pass.

## 9. Các quyết định đã chốt

Owner chốt ngày 2026-11-09:

1. Transfer cần cùng người là owner cả hai organization, không thêm lời mời.
2. `lbo_` được tạo `lbk_` cho site thuộc organization của nó.
3. Owner được đổi slug `default`; slug không được reserved sau khi đổi.
4. Settings luôn hiện Organization cho owner/admin; chỉ ẩn switcher khi có một org.
