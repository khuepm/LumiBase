# ADR-013 — Acceptance evidence

Phạm vi: Requirements 1–7, bốn quyết định design §9, task Phase 0–5. Đích tích hợp là `epic/organizations`; không merge epic vào main. Phase 5 đóng theo issue #640 sau khi CI của PR cuối xanh.

## Delivery

| Công việc | Issue | PR | Đích |
|---|---|---|---|
| Hotfix cross-tenant admin sites | #635 | #628 | main |
| ADR/spec prerequisite | #636 | #630 | epic/organizations |
| Phase 1 schema/setup/backfill | #634 | #641 | epic/organizations |
| Phase 2 API/guard/keys | #637 | #666 | epic/organizations |
| Phase 3 MCP/HITL | #638 | #768 | epic/organizations |
| Phase 4 Studio/session/shell | #639 | #769 | epic/organizations |
| Phase 5 docs/env/acceptance | #640 | PR liên kết issue #640 | epic/organizations |

## Requirements → evidence

| AC | Nguồn / kiểm chứng |
|---|---|
| 1.1 | `packages/database/src/schema/core.ts`: organization/member schema, PK/FK/role CHECK; migration integration tests |
| 1.2 | `0024_organizations.sql`: site parent backfill trước NOT NULL; test thiếu parent bị 23502 và delete RESTRICT bị 23503 |
| 1.3 | `organizations-migration.integration.test.ts`: 0/1/3 site × có/không bootstrap, legacy keys giữ site scope |
| 1.4 | `organization-operations.ts` + member routes: khóa organization trước khi kiểm tra owner cuối; real DB concurrent last-owner test. Trường hợp migration trước bootstrap không có member là ngoại lệ khởi tạo đã nêu ở 1.3; setup thêm bootstrap owner |
| 1.5 | Hai SQL migration viết tay + journal; đã rà tất cả branch/PR mở trước từng merge, không có số mới ở Phase 5 |
| 2.1 | `access.ts` + migration: CHECK scope/parent; invalid targets bị PostgreSQL từ chối |
| 2.2 | Shared `token-prefix.ts`, `api-key-token.ts`; real key create/auth/rotate tests |
| 2.3 | Org key routes và site key endpoint; real API test từ chối scope organization qua endpoint site |
| 2.4 | Auth parent verification + EffectiveCapabilityService; foreign site 403 và owned-site admin grant test |
| 2.5 | Auth matrix + real API/audit test: site/publishable/frontend credentials bị từ chối trước org policy với đúng audit reason |
| 2.6 | Caller class `organization_api_key`, controlPlaneAdmin/capability resolution tests và owned-site provisioning/key mint test |
| 3.1–3.2 | Pure `canOrg` trong contracts; fixed role/action matrix test, không gọi Policy DSL |
| 3.3 | Site admin resolver dùng chung, permission bundle và provenance; real owner/admin without-user_sites tests, audit via organization |
| 3.4 | Real password login tests cho billing và member không có direct site grant đều 403; resolver chỉ kế thừa owner/admin |
| 3.5 | Credential matrix và org guard: site administrator/site key không có quyền organization; chỉ membership org hoặc org key tương ứng được chấp nhận |
| 4.1 | Real `orgs.db.integration.test.ts`: CRUD/member/key/site routes, payload và envelope; API reference đủ cả 20 phương thức |
| 4.2 | Tenant recognition + organizationScopedDbFor; real non-superuser RLS và wrong-organization read/write tests |
| 4.3 | Shared provisionSite/finalize service; role/membership/extension/negative-cache tests và setup golden HTTP path |
| 4.4 | DELETE site scoped predicate và confirmation header; API tests + human approval delete/transfer race test |
| 4.5 | Same-human owner-both transfer checks trong shared mutation service; API và MCP approval DB tests |
| 4.6 | Default signup-off/bootstrap bypass + Studio-flag-on org creation tests; caller thành owner |
| 4.7 | Legacy admin site routes đã gỡ; k6 helpers dùng organization API/key và owner session cho cleanup |
| 4.8 | Comment và separate guard trong control-plane middleware; org namespace không nằm trong site CONTROL_PLANE_PATHS |
| 5.1 | configFromEnv tests: lbo unpinned được phép, site token thiếu site bị từ chối |
| 5.2 | Baseline JSON 161 tool names từ pre-Phase-3 epic, so sánh độc lập với registration hiện tại |
| 5.3 | Pinned profile snapshot = site tools + hai org reads |
| 5.4 | Unpinned profile snapshot = site tools + tám org tools; site arg bắt buộc; parallel header isolation test |
| 5.5 | Ba read-only profile snapshots; sample JSON README/locale MCP docs có LUMIBASE_READ_ONLY |
| 5.6 | Real zero-site org approvals, confirm escape rejection, revoked requester, owner-only decision, atomic same/conflicting concurrent decisions, deleted-destination rejection/receipt replay và human-only secret receipt tests |
| 5.7 | Default org flag và env-off tests cả discovery/call/approval; rejection vẫn được phép để đóng request |
| 5.8 | McpService/organization harness result và audit metadata mang organizationId/runId; pinned site run metadata cũng có org attribution |
| 6.1 | Single/multiple-org UI test và browser thực: switcher chỉ với nhiều org |
| 6.2 | Role-based page/tab/action tests, one-org Settings entry, cả root/custom-admin route tree, human receipt UI |
| 6.3 | Create-site UI test xóa old-site cache và chọn site mới; browser thực xác nhận HTTP site header sau reload |
| 6.4 | C1–C7 rà source: token-store/origin/Vite/shell format không đổi; refresh body theo session site gốc, clipboard fallback, real CORS preflight; browser 320px/390px/desktop |
| 7.1 | Setup creates Personal Org trước default site trong cùng transaction; golden HTTP E2E setup/login/schema/content/tenant isolation pass |
| 7.2 | Registry ID 196 giữ đúng một dòng cho toàn ADR, đủ seed/2 env/2 migration/caller class/UI; rà mọi PR mở |
| 7.3 | Sáu cặp docs thay đổi pass parity, verify/stamp/detect; guide Studio song ngữ đã có ở Phase 4; toàn bộ nội dung code-facing được đối chiếu nguồn |
| 7.4 | Ba hàng org credential matrix được thêm và chạy trong CMS suite |

## Checks đã chạy

- Node `v24.15.0`; full CMS suite: 4.240 test pass.
- Recursive `pnpm typecheck`: 18/18 package pass; `pnpm check:all`: 135 script tests pass.
- PostgreSQL broad suite Phase 4: 76 file / 860 test pass. Phase 5 bổ sung case billing; focused session suite hiện 6 test pass.
- Hai migration integration files: 8 test pass, gồm 0/1/3 site × bootstrap và non-superuser approval/org RLS.
- Golden HTTP E2E pass; final-head CI tiếp tục chạy full tests/build, DB integration, golden E2E, Worker bundle và scaffold install/typecheck.
- Compose config parse: base, production và GCP × defaults/overrides = 6 case pass. CMS nhận signup false/MCP on mặc định và true/off khi override; không chạy deploy.
- Sáu locale pair thay đổi: 0 lỗi parity. Code refs: 2.584 claim, 0 stale findings. Detect: 161 pair up-to-date, 0 planned translation.
- Global parity command vẫn trả 22 finding trong 17 pair cũ (B193). Đã so sánh cả EN và VI của từng pair lỗi với base HEAD: byte-identical. Không báo global parity là xanh và không sửa tài liệu không liên quan để che lỗi.

## Giới hạn giữ nguyên

- Billing thật, autonomy promotion L2+ và di chuyển instance settings ra khỏi site mặc định không thuộc ADR.
- B196: password-only recovery sau khi xóa toàn bộ site cần thiết kế identity/refresh cấp instance. Valid org credential/session vẫn có thể tạo lại site; nếu không còn credential thì khôi phục backup.
- B198 đã sửa: pending transfer reject và committed receipt replay vẫn hoạt động sau khi đích bị xóa; execution còn chờ vẫn yêu cầu đích/owner hợp lệ.
- B197: default ID của legacy site approvals chưa theo convention UUIDv7. New organization approvals đã dùng UUIDv7; không rewrite ID đã lưu.
