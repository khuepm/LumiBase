# Requirements Document — Organizations (organization plane)

> Status: **Proposal / Roadmap**. Thực thi [ADR-013](../../../docs/en/architecture/decisions/adr-013-organization-plane.md). Chưa bắt đầu.

## Introduction

LumiBase hiện chỉ có **một mặt phẳng: site**. `sites` không có cột cha, `api_keys`/`roles`/`user_sites` đều gắn `site_id`, nên không có dữ liệu nào trả lời "ai được tạo site, site này của ai". Hệ quả quan sát được:

- **GAP đã xác nhận:** `POST /api/v1/admin/sites` và `DELETE /api/v1/admin/sites/:id` ([`apps/cms/src/routes/admin.ts`](apps/cms/src/routes/admin.ts)) là route cho test runner, chỉ được `requireSiteAdmin` của site *đang gọi* bảo vệ — admin site A có thể tạo site tuỳ ý hoặc xoá site B. (Hotfix khoanh vùng làm riêng, ngoài spec này.)
- **GAP đã xác nhận:** MCP server ([`packages/mcp-server`](packages/mcp-server)) không có `create_site`/`list_sites` vì token `lbk_` chỉ biết một site — đúng với credential nó cầm, nhưng không có credential nào làm được việc đó.
- Bootstrap user (`users.is_bootstrap`) là principal duy nhất "trên site", nhưng chỉ là cờ boolean, không có API.

Spec này cung cấp:
1. **Tầng Organization** — bảng `organizations`, `organization_members`, `sites.organization_id`; backfill personal organization.
2. **Organization key `lbo_`** — credential phân loại theo phạm vi, tách khỏi `lbk_`.
3. **API `/api/v1/orgs`** — tạo/xoá/chuyển site, thành viên, key; gỡ route `/admin/sites`.
4. **MCP** — bộ tool do loại token quyết định; tool org đi qua HITL.
5. **Studio** — organization switcher, trang quản trị org (ẩn khi chỉ có một org).

Thuật ngữ **"control plane"** trong code hiện là *quản trị phạm vi site* (`CONTROL_PLANE_PATHS`, `controlPlaneAdmin`) và **giữ nguyên**; tầng mới gọi là **organization plane**.

## Glossary

- **Organization**: tài khoản tenant sở hữu N site. Có `slug` duy nhất, `settings` JSONB.
- **Org_Member**: dòng `(user_id, organization_id, role)`; `role ∈ {owner, admin, billing, member}` — enum đóng, không phải dòng trong `roles`.
- **Personal_Org**: organization tạo tự động khi backfill (`slug='default'`) hoặc khi user đăng ký lần đầu ở bản hosted.
- **Org_Key**: API key `scope='organization'`, prefix `lbo_`, mang `organization_id`; được coi là `administrator` trên mọi site của org, có thể **Site_Pin**.
- **Site_Pin**: `LUMIBASE_SITE_ID` (MCP) hoặc `X-Lumi-Site` (REST) đi kèm Org_Key để thu hẹp key về một site.
- **Org_Action**: một trong `org:read`, `org:sites:create`, `org:sites:delete`, `org:sites:transfer`, `org:members:manage`, `org:keys:manage`, `org:billing:manage`, `org:settings:write`, `org:delete`.
- **Instance_Operator**: user `is_bootstrap`; cùng env của process là **instance plane** (không đổi so với hiện tại).

## Requirements

### Requirement 1: Mô hình dữ liệu Organization

**User Story:** Là một operator, tôi muốn mỗi site thuộc về một organization có chủ sở hữu rõ ràng, để câu hỏi "site này của ai, ai được tạo thêm" có câu trả lời trong dữ liệu.

#### Acceptance Criteria

1. THE hệ thống SHALL thêm bảng `lumibase_organizations` (`id` nanoid, `slug` unique, `name`, `settings` jsonb default `{}`, `created_at`, `updated_at`) và `lumibase_organization_members` (PK `(user_id, organization_id)`, `role` text CHECK ∈ 4 giá trị, `created_at`), theo ADR-001/ADR-010.
2. THE bảng `sites` SHALL có cột `organization_id` FK → `organizations.id` ON DELETE RESTRICT; nullable trong migration, `NOT NULL` sau backfill (cùng migration, hai bước).
3. THE migration SHALL backfill: tạo Personal_Org cho user `is_bootstrap` (nếu không có user bootstrap → `slug='default'`, không member), gắn **mọi** site hiện có vào org đó, thêm user bootstrap làm `owner`.
4. THE hệ thống SHALL bảo đảm mỗi organization luôn có ≥ 1 `owner` (từ chối xoá/hạ cấp owner cuối cùng với `409 LAST_OWNER`).
5. THE migration SHALL viết tay + sửa journal (quy ước dự án), và số thứ tự SHALL được đối soát với mọi branch mở lúc merge.

### Requirement 2: Organization key (`lbo_`)

**User Story:** Là một operator, tôi muốn một loại credential riêng cho việc quản trị organization, để key site (`lbk_`) dù bị lộ cũng không bao giờ tạo/xoá được site.

#### Acceptance Criteria

1. THE bảng `api_keys` SHALL thêm `scope` text ∈ `{'site','organization'}` default `'site'` và `organization_id` FK nullable; `site_id` trở thành nullable với CHECK: `(scope='site' AND site_id IS NOT NULL AND organization_id IS NULL) OR (scope='organization' AND organization_id IS NOT NULL AND site_id IS NULL)`.
2. THE Org_Key SHALL có prefix `lbo_` (tiền lệ `lbk_pub_` ở [`api-key-publishable.ts`](apps/cms/src/services/api-key-publishable.ts)); token hash/lookup dùng lại [`api-key-token.ts`](apps/cms/src/services/api-key-token.ts).
3. THE Org_Key SHALL chỉ được tạo/xoay/thu hồi qua `/api/v1/orgs/:orgId/keys` bởi principal có `org:keys:manage`; `/api/v1/api-keys` SHALL từ chối tạo `scope='organization'` (`400 SCOPE_NOT_ALLOWED`).
4. WHEN Org_Key gọi một route site plane kèm `X-Lumi-Site`, THE `EffectiveCapabilityService` SHALL kiểm tra site thuộc org của key rồi cấp capability `administrator` của site đó; nếu site không thuộc org → `403 SITE_NOT_IN_ORGANIZATION`.
5. WHEN `lbk_` (hoặc `lbk_pub_`, hoặc session `aud=frontend`) gọi bất kỳ route `/api/v1/orgs/*`, THE hệ thống SHALL trả `403 ORGANIZATION_FORBIDDEN` **trước** mọi đánh giá policy, và ghi `audit_log` qua `auditSecurityGuardDenied` với reason `site_scoped_credential_on_org_plane`.
6. THE `EffectiveCapabilityService` SHALL thêm caller class `organization_api_key`; `controlPlaneAdmin` của Org_Key trên site được ghim = `true` (khác với `lbk_` admin-policy = `false` như hiện tại, [`effective-capability-service.ts`](apps/cms/src/services/effective-capability-service.ts)).

### Requirement 3: Phân quyền organization plane

**User Story:** Là một org owner, tôi muốn phân vai owner/admin/billing/member với quyền cố định, để review bảo mật đọc được bảng quyền mà không cần hiểu Policy DSL.

#### Acceptance Criteria

1. THE hệ thống SHALL đánh giá Org_Action theo bảng cố định trong ADR-013 §2 (owner: tất cả; admin: read, sites:create, members, keys, settings; billing: read, billing; member: read).
2. THE Org_Action SHALL **không** đi qua Policy DSL (ADR-008); một hàm thuần `canOrg(role, action): boolean` trong `packages/contracts` để CMS + Studio dùng chung.
3. WHEN principal là `owner` hoặc `admin` của org, THE `hasSiteAdminAccess` (route admin, control-plane guard) SHALL trả `true` cho mọi site thuộc org đó sau khi tra `user_sites` không thấy, và `audit_log` của request SHALL mang `via: 'organization'`.
4. THE `billing` và `member` SHALL không kế thừa quyền site nào.
5. THE site `administrator`, `lbk_`, `controlPlaneAdmin` SHALL không có Org_Action nào (không kế thừa lên).

### Requirement 4: API organization plane

**User Story:** Là một developer, tôi muốn REST API tạo/xoá/chuyển site và quản lý thành viên org, để Studio, CLI, MCP và test runner dùng chung một đường.

#### Acceptance Criteria

1. THE CMS SHALL mount `orgsRouter` tại `/api/v1/orgs` với các route trong ADR-013 §4; response theo `{ data, meta? }` / `{ errors }` (rule #5).
2. THE tenant middleware ([`tenant.ts`](apps/cms/src/middleware/tenant.ts)) SHALL miễn `X-Lumi-Site` cho prefix `/api/v1/orgs`; RLS request scope (spec [`rls-request-scope`](../rls-request-scope/design.md)) SHALL set theo `organization_id`.
3. `POST /api/v1/orgs/:orgId/sites` SHALL nhận `{ id?, name, slug? }` validate Zod ở `packages/contracts/src/schemas/`, và SHALL chạy cùng provisioning với setup wizard: upsert role `administrator`/`member` ([`setup/service.ts`](apps/cms/src/modules/setup/service.ts) `upsertAdministratorRole`/`upsertMemberRole` tách ra dùng chung), `reconcileOfficialExtensions`, purge negative cache; người gọi (nếu là user) được thêm `user_sites` với role `administrator`.
4. `DELETE /api/v1/orgs/:orgId/sites/:siteId` SHALL yêu cầu `org:sites:delete`, header `X-Confirm-Delete: <siteId>`, và từ chối nếu `siteId` không thuộc `orgId` (`404`, không lộ tồn tại).
5. `POST .../sites/:siteId/transfer` `{ toOrganizationId }` SHALL yêu cầu `owner` ở **cả hai** org (owner đã chốt 2026-11-09, không dùng lời mời ở Phase 2).
6. `POST /api/v1/orgs` SHALL được phép khi: principal là Instance_Operator, HOẶC `LUMIBASE_ALLOW_ORG_SIGNUP=true` và principal có `aud=studio`; nếu không → `403 ORG_SIGNUP_DISABLED`.
7. THE route `POST/DELETE /api/v1/admin/sites*` SHALL bị gỡ khỏi [`admin.ts`](apps/cms/src/routes/admin.ts) sau khi test runner chuyển sang `/api/v1/orgs/:orgId/sites` với Org_Key.
8. THE `/api/v1/orgs` SHALL được thêm vào `CONTROL_PLANE_PATHS`? **Không** — guard đó kiểm tra admin *site*; `/api/v1/orgs` dùng guard riêng `withOrganizationAccessGuard` (Req 2.5, 3). Phải ghi rõ trong code comment để tránh ai đó thêm nhầm.

### Requirement 5: MCP

**User Story:** Là một người dùng AI agent, tôi muốn cấu hình MCP bằng Org_Key để agent tạo site mới dưới sự phê duyệt của tôi, trong khi cấu hình `lbk_` hiện tại không thay đổi gì.

#### Acceptance Criteria

1. THE MCP server SHALL nhận diện loại token từ prefix lúc khởi động ([`client.ts` `configFromEnv`](packages/mcp-server/src/client.ts)); `LUMIBASE_SITE_ID` SHALL là **tuỳ chọn** khi token là `lbo_` và vẫn **bắt buộc** khi là `lbk_`.
2. WHEN token là `lbk_`, THE bộ tool SHALL không đổi so với hiện tại (snapshot test danh sách tool).
3. WHEN token là `lbo_` + Site_Pin, THE bộ tool SHALL = bộ tool site + `list_sites`, `get_organization` (chỉ đọc).
4. WHEN token là `lbo_` không pin, THE bộ tool SHALL = tool org (`list_sites`, `create_site`, `delete_site`, `transfer_site`, `list_org_members`, `invite_org_member`, `create_org_key`) + tool site nhận tham số `site` bắt buộc.
5. THE env `LUMIBASE_READ_ONLY=true` SHALL ẩn mọi tool ghi bất kể token; README SHALL dùng nó trong mọi snippet cấu hình mẫu.
6. THE tool org ghi (`create_site`, `delete_site`, `transfer_site`, `invite_org_member`, `create_org_key`) SHALL đi qua `ai_approvals` (rule #4) khi gọi qua governed harness, ở autonomy L0/L1, không có đường `confirm=true` bỏ qua.
7. THE setting org `contentOs.mcp.allowOrganizationTools` (default `false`) SHALL gate tool org; env `LUMIBASE_MCP_ORG_TOOLS=off` ở CMS SHALL ép tắt bất kể setting.
8. THE governed harness ([`governed.ts`](packages/mcp-server/src/governed.ts)) và `McpService` SHALL mang `organizationId` trong run audit.

### Requirement 6: Studio

**User Story:** Là một admin có nhiều site, tôi muốn chuyển giữa các site và quản lý organization trong Studio, nhưng khi chỉ có một org thì không thấy gì khác so với hôm nay.

#### Acceptance Criteria

1. THE Studio SHALL hiển thị organization switcher trong shell chỉ khi `GET /api/v1/orgs` trả > 1 org.
2. THE Studio SHALL có trang **Organization settings** (members, sites, keys, general) chỉ cho principal có `org:read`, tab theo Org_Action.
3. THE trang Sites SHALL có nút "Create site" khi `org:sites:create`; tạo xong chuyển `X-Lumi-Site` sang site mới.
4. THE `apps/shell` contract (DoD §2d, [`apps/shell/README.md`](apps/shell/README.md)) SHALL không đổi: token/session format giữ nguyên; `X-Lumi-Site` vẫn là cách chọn site; `/api/v1/orgs` là endpoint additive.

### Requirement 7: Setup, docs, DoD

#### Acceptance Criteria

1. THE setup wizard SHALL tạo Personal_Org cho bootstrap user ở bước initialize (cùng transaction tạo `__default__`), để bản cài mới không cần backfill.
2. THE Setup Impact Registry ([`setup-impact.md`](../admin-setup-wizard/setup-impact.md)) SHALL có dòng cho spec này: seed (Personal_Org), env mới (`LUMIBASE_ALLOW_ORG_SIGNUP`, `LUMIBASE_MCP_ORG_TOOLS`), migration + backfill, capability mới.
3. THE docs SHALL cập nhật song ngữ cùng commit: `api/hono-api-spec.md` (section Organizations), `security/user-management.md` (bảng realm thêm hàng Organization key; §7 MCP), `mcp/*` (cấu hình `lbo_`, `LUMIBASE_READ_ONLY`), `data-model.md`.
4. THE test ma trận auth ([`auth-middleware-matrix.test.ts`](apps/cms/src/__tests__/auth-middleware-matrix.test.ts)) SHALL thêm hàng: `lbk_` → `/api/v1/orgs` = 403; `lbo_` + site ngoài org → 403; `lbo_` không `X-Lumi-Site` → route site = 400 TENANT_REQUIRED.

## Out of scope

- Billing thực tế (chỉ chừa `org:billing:manage` và `settings.billing` jsonb).
- Dời setting toàn instance khỏi `__default__` (ADR sau).
- Nhiều tầng (folder/OU) giữa organization và site.
- Promotion autonomy L2+ cho tool org.
