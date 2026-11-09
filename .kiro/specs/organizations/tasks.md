# Tasks — Organizations (organization plane)

> Status: **In Progress**. Phase 1 đã merge #641; Phase 2 đã merge #666; Phase 3 triển khai #638; Phase 4–5 còn lại. Thực thi [ADR-013](../../../docs/en/architecture/decisions/adr-013-organization-plane.md). Mỗi phase là một PR riêng; Phase 0 phải merge trước.

## Phase 0 — Tiền đề (ngoài spec, đã có task riêng)
- [x] 0.1 Hotfix khoanh vùng `POST/DELETE /api/v1/admin/sites`: xoá site khác tenant → 403; tạo site hoặc xoá site khác cần env `LUMIBASE_ALLOW_ADMIN_SITE_MANAGEMENT=true` (dành cho test runner). PR khuepm/LumiBase#628. Phase 2.10 gỡ cả route lẫn env này.
- [x] 0.2 Chốt 4 open questions ở [design §9](design.md#9-open-questions) với owner dự án.

## Phase 1 — Schema + backfill (Req 1, 2.1)

Bao gồm seed Personal_Org từ task 5.1 trước insert `__default__`; tách `provisionSite` vẫn ở Phase 2.5.
- [x] 1.1 `organizations`, `organizationMembers` trong [`core.ts`](packages/database/src/schema/core.ts); `sites.organizationId` (Req 1.1–1.2).
- [x] 1.2 `apiKeys.scope`, `apiKeys.organizationId`, `siteId` nullable + CHECK `api_keys_scope_target` trong [`access.ts`](packages/database/src/schema/access.ts) (Req 2.1).
- [x] 1.3 Migration viết tay `0024_organizations.sql` + journal: tạo bảng → add cột → backfill Personal_Org → `SET NOT NULL` → api_keys (design §1). Đối soát số với mọi branch mở lúc merge.
- [x] 1.4 RLS policy cho hai bảng mới + biến `lumibase.organization_id` trong request scope (design §1 RLS).
- [x] 1.5 DB integration test backfill: 0/1/N site, có/không bootstrap user (design §8).
- [x] 1.6 `packages/contracts/src/org-permissions.ts`: `ORG_ACTIONS`, `OrgRole`, `canOrg()` thuần + unit test bảng quyền (Req 3.1–3.2).
- [x] 1.7 `classifyTokenPrefix()` trong `packages/contracts`; hằng `ORGANIZATION_TOKEN_PREFIX='lbo_'` (design §2.1).

## Phase 2 — Credential + guard + API (Req 2, 3, 4)
- [x] 2.1 [`middleware/auth.ts`](apps/cms/src/middleware/auth.ts): gắn `auth.apiKey.scope/organizationId`; chặn credential site-scoped trên `/api/v1/orgs/*` → `403 ORGANIZATION_FORBIDDEN` + audit (Req 2.5).
- [x] 2.2 [`effective-capability-service.ts`](apps/cms/src/services/effective-capability-service.ts): caller class `organization_api_key`; resolve `lbo_` + `X-Lumi-Site` → verify site ∈ org, grant `administrator`, `controlPlaneAdmin: true`; sai org → `403 SITE_NOT_IN_ORGANIZATION` (Req 2.4, 2.6).
- [x] 2.3 `middleware/organization-access-guard.ts`: `withOrganizationAccessGuard(action)`; Org_Key = role ảo `admin`; user tra `organization_members`; 404 không lộ tồn tại (design §3).
- [x] 2.4 `services/site-admin-access.ts`: gộp hai `hasSiteAdminAccess` ([`admin.ts:69`](apps/cms/src/routes/admin.ts:69), [`control-plane-access-guard.ts`](apps/cms/src/middleware/control-plane-access-guard.ts)) → `resolveSiteAdminAccess(c)` trả `{ allowed, via }`; fallback `organization_members` owner/admin; audit ghi `via` (Req 3.3).
- [x] 2.5 `services/site-provisioning.ts`: tách upsert role Administrator/Member khỏi `SetupService` ([`setup/service.ts`](apps/cms/src/modules/setup/service.ts) ~990/~1034) thành `provisionSite()`; `SetupService.initialize` gọi lại (design §4.1).
- [x] 2.6 Zod `packages/contracts/src/schemas/organizations.ts` (design §4).
- [x] 2.7 `routes/orgs.ts`: toàn bộ bảng route design §4; mount `/orgs` trong [`index.ts`](apps/cms/src/index.ts); [`tenant.ts`](apps/cms/src/middleware/tenant.ts) miễn `X-Lumi-Site` cho `/api/v1/orgs` (Req 4.1–4.2).
- [x] 2.8 `POST /orgs` gate: Instance_Operator hoặc `LUMIBASE_ALLOW_ORG_SIGNUP=true` + `aud=studio` (Req 4.6).
- [x] 2.9 `/orgs/:orgId/keys`: mint `lbo_`, trả token một lần; `/api/v1/api-keys` từ chối `scope='organization'` → `400 SCOPE_NOT_ALLOWED` (Req 2.3).
- [x] 2.10 Chuyển test runner / helper test sang `POST /orgs/:orgId/sites` với Org_Key (tạo site); cleanup xoá site dùng Studio owner session vì key không có quyền owner; **xoá** `POST/DELETE /admin/sites` khỏi [`admin.ts`](apps/cms/src/routes/admin.ts) (Req 4.7).
- [x] 2.11 Test: `auth-middleware-matrix` (3 hàng mới, Req 7.4), `routes/__tests__/orgs.test.ts`, `site-provisioning.test.ts` (design §8).
- [x] 2.12 Comment rõ trong `control-plane-access-guard.ts`: KHÔNG thêm `/api/v1/orgs` vào `CONTROL_PLANE_PATHS` (Req 4.8).

## Phase 3 — MCP (Req 5)
- [x] 3.1 [`client.ts` `configFromEnv`](packages/mcp-server/src/client.ts): `tokenKind`, `siteId` tuỳ chọn với `lbo_`, `readOnly`; `siteOverride` per call (design §5.1–5.2).
- [x] 3.2 `registerAllTools(server, client, config)`: ba cấu hình + `readOnly` lọc theo `annotations` (design §5.2); `requireSiteArg` cho tool site.
- [x] 3.3 `tools/organization.ts`: 8 tool org theo bảng design §5.3.
- [x] 3.4 CMS [`routes/mcp.ts`](apps/cms/src/routes/mcp.ts): `controlPlaneSkillFromCall` nhận diện `org:*`; gate `settings.contentOs.mcp.allowOrganizationTools` + env `LUMIBASE_MCP_ORG_TOOLS` (Req 5.7); `McpService`/governed harness mang `organizationId` (Req 5.8).
- [x] 3.5 HITL: tool org ghi tạo `ai_approvals` ở L0/L1; `create_org_key` trả token chỉ trong approval record (Req 5.6).
- [x] 3.6 Snapshot test tool list ×3 + `readOnly` ([`tools.test.ts`](packages/mcp-server/src/__tests__/tools.test.ts)); test `lbk_` list **bằng** snapshot hiện tại (Req 5.2).
- [x] 3.7 [`README.md`](packages/mcp-server/README.md) + `docs/{en,vi}/mcp/*`: cấu hình `lbo_`, `LUMIBASE_SITE_ID` tuỳ chọn, `LUMIBASE_READ_ONLY` trong mọi snippet (Req 5.5).

## Phase 4 — Studio (Req 6)
- [ ] 4.1 `lib/api.ts`: client `orgs` không `X-Lumi-Site`; `useOrganizations()`.
- [ ] 4.2 Organization switcher trong shell, chỉ khi > 1 org (Req 6.1).
- [ ] 4.3 Module `modules/organization/` (general, sites, members, keys), tab theo `canOrg` (Req 6.2); mục "Organization" luôn hiện trong Settings cho owner/admin (design §9.4).
- [ ] 4.4 "Create site" → `setSite(newId)` (Req 6.3).
- [ ] 4.5 Kiểm tra contract `apps/shell` C1–C7 không đổi (Req 6.4).
- [ ] 4.6 (Tuỳ chọn) `transfer_site` bằng lời mời nếu chốt ở 0.2.

## Phase 5 — Setup, docs, DoD (Req 7)
- [x] 5.1 (Personal_Org seed Phase 1; dùng chung `provisionSite` Phase 2) `SetupService.initialize`: tạo Personal_Org + `provisionSite` với `organizationId`, idempotent (Req 7.1; design §7).
- [ ] 5.2 Setup Impact Registry [`setup-impact.md`](../admin-setup-wizard/setup-impact.md): một dòng (seed, 2 env, migration+backfill, capability); ID > mọi branch mở ([[registry-ids-collide-across-open-prs]]).
- [ ] 5.3 Docs song ngữ cùng commit: `api/hono-api-spec.md` (Organizations + mã lỗi mới), `security/user-management.md` (hàng Organization key; §7), `data-model.md`, `mcp/*`; chạy `docs:i18n:parity` → `verify` → `stamp-pair --verified` → `detect` (Req 7.3).
- [ ] 5.4 ADR-013 `Status: Proposed → Accepted` ở cả `docs/en` và `docs/vi` khi Phase 2 merge.
- [ ] 5.5 `.env.example`, `docker/.env*.example`, `docker-compose*.yml`: `LUMIBASE_ALLOW_ORG_SIGNUP`, `LUMIBASE_MCP_ORG_TOOLS`.
- [ ] 5.6 `turbo run typecheck` recursive ([[typecheck-recursive-vs-per-package]]); full CMS suite trên Node 24.
- [ ] 5.7 Changelog: ghi migration không rollback tự động; hướng dẫn self-host "bạn sẽ thấy một organization `default`".
