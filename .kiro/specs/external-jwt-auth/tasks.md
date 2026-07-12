# Implementation Plan

## Overview

Kế hoạch triển khai **External JWT Authentication** theo 5 phase. Phase A đặt nền dữ liệu (bảng `auth_external_issuers` viết tay + Drizzle table + Zod schema). Phase B xây ExternalIssuerService + admin CRUD endpoints (gated `adminAccess`). Phase C xây ExternalJwtVerifier (decode→verify chữ ký→validate claim→resolve site→map role default-deny→JIT) và chèn đúng vị trí trong `withAuth`. Phase D phủ test bảo mật (cây quyết định, multi-tenant, role-mapping, chain, CRUD). Phase E hoàn thiện docs + Setup Impact + DoD. Mỗi task gắn ref requirement + section design. Mỗi task = một commit riêng (theo memory commit conventions: tách commit, author Javier, không Claude co-author).

> Lưu ý xuyên suốt: dùng `nanoid()` cho `id` (Rule #1); scope `site_id` mọi query (Rule #2); cache qua `c.get('runtime').cache` (Rule #3); response `{ data }`/`{ errors }`; `import type`, strict TS, không `any`. **Không** thêm dependency JWT (dùng `jose` sẵn có).

## Tasks

### Phase A — Data model: bảng issuer, Drizzle table, Zod schema

- [x] 1. Migration & schema bảng `auth_external_issuers`
  - [x] 1.1 Viết tay `packages/database/drizzle/0032_auth_external_issuers.sql`: `CREATE TABLE IF NOT EXISTS auth_external_issuers (...)` đúng §3 (id nanoid PK, site_id, issuer, jwks_uri, discovery_url, audience jsonb, algorithms jsonb, claim_mapping jsonb, role_mapping jsonb, default_role_id, jit_provisioning, clock_skew_seconds, enabled, timestamps), `UNIQUE(site_id, issuer)`, `INDEX(site_id, enabled)` — idempotent (Req 1.1, 1.3, 12.5; design §3, §11)
  - [x] 1.2 Thêm entry `0032` vào `packages/database/drizzle/meta/_journal.json` bằng tay — KHÔNG `drizzle-kit generate` (memory "Migrations are hand-written") (Req 12.5; design §11)
  - [x] 1.3 Định nghĩa Drizzle table trong `packages/database/src/schema/external-auth.ts` (hoặc append `access.ts`); export từ `schema/index.ts` (Req 1.1; design §3)
  - [x] 1.4 Chạy `pnpm -F @lumibase/database db:migrate` trên DB local, xác nhận bảng tạo + idempotent khi chạy lại (Req 12.5; design §11)

- [x] 2. Zod schema chia sẻ
  - [x] 2.1 Tạo `packages/shared/src/schemas/external-issuer.ts`: `ExternalIssuerConfigSchema` + type `ExternalIssuerConfig`; `algorithms` enum chỉ `RS*/ES*` (không `HS*`/`none`); `claimMapping` `.strict()`; `roleMapping` record; URL fields `https://` (localhost khi dev); `clockSkewSeconds` `[0,300]` default 60 (Req 1.2, 1.5, 1.6, 2.3, 2.4, 12.4; design §4)
  - [x] 2.2 Export từ `packages/shared/src/schemas/index.ts` (Req 1.5; design §4)
  - [x] 2.3 Unit test schema: reject `HS256`/`none` trong `algorithms`, reject khoá lạ trong `claimMapping`, reject URL non-https ngoài dev, accept config tối thiểu hợp lệ (Req 2.3, 1.5; design §4)

### Phase B — ExternalIssuerService & admin CRUD

- [x] 3. ExternalIssuerService
  - [x] 3.1 Tạo `apps/cms/src/services/external-issuer-service.ts`: `list/get/create/update/delete` scoped `siteId`; `create`/`update` validate qua Zod, enforce `(siteId, issuer)` unique → 409 `ISSUER_ALREADY_EXISTS`; reject thiếu cả `jwksUri`+`discoveryUrl` → 422 `JWKS_SOURCE_REQUIRED` (Req 1.1-1.4, 2.3; design §5)
  - [x] 3.2 `getTrustedIssuers(siteId)` trả bản ghi `enabled=true`; loại trường nghi-secret trước khi lưu (Req 1.7, 2.5; design §5, §7)
  - [x] 3.3 Audit `external_issuer_created/updated/deleted` với metadata `{ issuer, siteId }` — không token/claim (Req 2.7; design §5, §10)

- [x] 4. Admin endpoints `/api/v1/admin/auth/issuers`
  - [x] 4.1 Tạo `apps/cms/src/routes/admin-auth-issuers.ts` với 5 handler CRUD trả `{ data }`/`{ errors }`; helper `requireAdmin(c)` dùng `PermissionService.bundle().admin` → 403 `FORBIDDEN` nếu không admin (Req 2.1, 2.2; design §5, §9)
  - [x] 4.2 Mount router vào app (cùng nơi các route admin khác trong `apps/cms/src/index.ts`) (Req 2.1; design §5)
  - [x] 4.3 Validate ở handler: `algorithms` allowlist → 422 `ALGORITHM_NOT_ALLOWED`; URL → 422 `INVALID_URL`; response không echo secret (Req 2.3, 2.4, 2.5; design §4, §5)

### Phase C — ExternalJwtVerifier & tích hợp chuỗi withAuth

- [x] 5. Verifier core
  - [x] 5.1 Tạo `apps/cms/src/modules/external-auth/verifier.ts` export `tryExternalJwt(c, token): Promise<{kind:'authenticated',principal} | {kind:'rejected',response} | {kind:'skip'}>` (Req 7.3, 7.4; design §6.1)
  - [x] 5.2 Decode `iss`/`kid`/`alg` không xác thực; load `getTrustedIssuers(siteId)` từ cache; match `config.issuer === iss`; không khớp → `skip` (Req 7.5, 4.4; design §6.2)
  - [x] 5.3 Verify chữ ký: reject `alg` ngoài allowlist / `none` / `HS*` → `rejected` 401; `jwtVerify(token, getJwks(jwksUri), { issuer, audience, algorithms, clockTolerance })`; map lỗi jose → `rejected` + audit reason (Req 3.1-3.6, 4.1-4.5; design §6.2, §6.3)
  - [x] 5.4 Kiểm `iat` tương lai vượt skew (Req 4.6; design §6.3)
  - [x] 5.5 Resolve site: `claimMapping.siteId` khớp request site hoặc dùng request site (issuer đã scoped theo site ở 5.2); mismatch → `rejected` 403 `SITE_MISMATCH`; không resolve >1 site (Req 5.1-5.5; design §6.4, §10 T3)
  - [x] 5.6 Map claims→roles default-deny: chuẩn hoá role claim → mảng; tra `roleMapping`; phân giải `roleId`/`systemKey` sang `roles` của site (qua `roles_site_system_key_unique`); rỗng + không `defaultRoleId` → `rejected` 403 `NO_ROLE_MAPPING`; KHÔNG hard-code admin (Req 6.1-6.7; design §6.5, §8, §10 T2)
  - [x] 5.7 JIT provisioning: match `users` theo `external_id`; inactive → 401; missing + JIT off → 403 `USER_NOT_PROVISIONED`; JIT on → insert user (`onConflictDoNothing(external_id)`) + upsert `userSites(userId, siteId, roleId)` idempotent; audit `external_user_provisioned` (Req 9.1-9.6; design §6.6)
  - [x] 5.8 Dựng `AuthPrincipal { type:'user', userId, externalId, email, roles, raw:payload }` cho nhánh `authenticated` (Req 6.5; design §6.5, §6.6)

- [x] 6. JWKS & issuer-config caching
  - [x] 6.1 Tái dùng `getJwks`/`JWKS_CACHE` của `middleware/auth.ts:9-18`; thêm cooldown/rate-limit refetch per `jwksUri` + timeout fetch (fail-closed khi không có cache) (Req 8.1-8.4, 3.6; design §7)
  - [x] 6.2 OIDC discovery (khi `discoveryUrl`): fetch `.well-known`, suy `jwks_uri`, validate `issuer` khớp, cache TTL riêng qua `runtime.cache` (Req 8.5; design §7)
  - [x] 6.3 Cache `getTrustedIssuers(siteId)` qua `c.get('runtime').cache` key `auth:issuers:<siteId>` TTL ≤ 60s; invalidate khi PATCH/DELETE issuer (Req 8.6, 2.6, 12.1; design §7) (adapter.ts đọc/ghi key `auth:issuers:<siteId>` TTL 60s, cache access defensive để auth middleware fail-closed nếu thiếu runtime ctx; `ExternalIssuerService` drop key trên create/update/delete; unit `issuer-cache.test.ts` 3 test + case invalidation trong DB-integration)

- [x] 7. Tích hợp vào `withAuth`
  - [x] 7.1 Chèn khối gọi `tryExternalJwt` trong block `if (bearerToken)` của `apps/cms/src/middleware/auth.ts` — SAU nhánh API-key (`auth.ts:166-218`), TRƯỚC nhánh custom JWT (`auth.ts:229-275`): `authenticated`→set principal+next; `rejected`→return response (fail-closed); `skip`→rơi xuống custom JWT (Req 7.1-7.4; design §6.1)
  - [x] 7.2 Giữ nguyên các path bỏ-qua-auth (`auth.ts:80-87`), dev-auth (`auth.ts:97-123`), nhánh CF Access (`auth.ts:125-159`); không đổi hành vi cũ (Req 7.6, 12.2; design §6.1)
  - [x] 7.3 Logging/error policy: dùng `formatSafeError`; không log raw token; response dùng mã chung `UNAUTHENTICATED`/`FORBIDDEN`/`TOKEN_EXPIRED`; audit `external_auth_denied` theo khuôn `auditApiKeyUseDenied` (`auth.ts:49-69`) (Req 10.1-10.3; design §10 T6, T8)
  - [x] 7.4 Giới hạn kích thước token + độ lớn claim (chống parsing DoS) (Req 11.7; design §10 T7)

### Phase D — Tests (bảo mật là trọng tâm)

- [x] 8. Verifier unit + integration tests
  - [x] 8.1 `verifier.test.ts`: sinh keypair RS256/ES256 (jose `generateKeyPair`); accept token hợp lệ; reject `alg:none`, `HS256`, sai `aud`, sai `iss`, hết `exp`, `nbf` tương lai, `kid` lạ (cây quyết định design §10) (Req 13.1; design §10, §12)
  - [x] 8.2 Multi-tenant test: token site A + `X-Lumi-Site:B` → reject `SITE_MISMATCH`; cùng `iss` hai site dùng config độc lập (Req 13.2; design §6.4, §10 T3)
  - [x] 8.3 Role-mapping test: default-deny → 403 `NO_ROLE_MAPPING`; map→role `adminAccess=true` → principal admin qua `PermissionService`; xác nhận KHÔNG có path hard-code `['admin']` (Req 13.3; design §6.5, §8, §10 T2)
  - [x] 8.4 JIT test: on → tạo `users`+`userSites` idempotent (chạy 2 lần không trùng); off → 403 `USER_NOT_PROVISIONED`; user inactive → 401 (Req 13.4; design §6.6)
  - [x] 8.5 Chain test: API key ưu tiên hơn external; bearer non-JWT → fallback custom JWT; `iss` khớp + verify fail → KHÔNG fallback (fail-closed) (Req 13.5; design §6.1, §10 T9)
  - [x] 8.6 Admin CRUD integration test: tạo/sửa/xoá issuer; enforce `adminAccess` (403 cho non-admin); reject `HS256` trong `algorithms`; reject thiếu JWKS source (Req 13.6, 2.2, 2.3; design §5)

### Phase E — Docs, Setup Impact, DoD

- [x] 9. Docs
  - [x] 9.1 Cập nhật `docs/en/api/hono-api-spec.md`: thêm mục admin CRUD `/api/v1/admin/auth/issuers` (params, body, response, error codes `ISSUER_ALREADY_EXISTS`/`ALGORITHM_NOT_ALLOWED`/`JWKS_SOURCE_REQUIRED`/`INVALID_URL`) dưới section auth/admin; ghi rõ external JWT presented as `Authorization: Bearer` được verify transparent trong middleware (không endpoint login mới) (DoD §4; Req 2, 7)
  - [x] 9.2 Thêm trang hướng dẫn `docs/en/` (vd "External JWT Authentication"): cấu hình issuer cho Okta/Entra/Auth0/Logto/Keycloak, claim/role mapping, multi-tenant, JIT, và **cảnh báo bảo mật** (default-deny, chỉ RS*/ES*, fail-closed) (DoD §4; Req 6, 11)
  - [x] 9.3 CHANGELOG entry (feature mới); README bump nếu version tăng — giữ narrative hiện có (DoD §4)

- [x] 10. Setup Impact
  - [x] 10.1 Thêm dòng vào `.kiro/specs/admin-setup-wizard/setup-impact.md` (Registry): feature `external-jwt-auth`, trạng thái **`n/a`**, ngày rà soát, lý do — bảng `auth_external_issuers` không seed (rỗng, admin đăng ký theo nhu cầu, giống #7/#16); không settings key bắt buộc; không bước wizard; không capability flag; migration `0032` chỉ `CREATE TABLE IF NOT EXISTS` nên KHÔNG cần backfill (instance cũ → external `skip` mọi token, auth hiện có giữ nguyên) (Req 14; design §13; DoD §2)

- [x] 11. Definition of Done
  - [x] 11.1 `pnpm typecheck` recursive (15/15) ✅ + targeted tests pass trên Postgres local (DoD §1, §3; Req 13)

---

## Implementation status (2026-06-22)

**Done — all phases** (commits split per task; author Javier; PR riêng).

**Deviations:**
- **Migration `0042_auth_external_issuers`** (renumber 0034→0042 khi merge main v0.15) — `0032`/`0033` đã thuộc content-releases / save-default-preference (PR riêng đang mở). Renumber nếu merge order khác.
- **CF Access bug (`auth.ts:147` hard-code `roles:['admin']`)**: theo open question §2, **giữ nhánh CF Access nguyên trạng** v1 để tránh regression — đã ghi chú trong `docs/en/security/external-jwt-auth.md`. Path external-JWT mới KHÔNG có bug này (default-deny). Gỡ bug CF Access là v2.
- **Studio UI quản lý issuer**: chưa làm (admin API là đủ cho v1; UI là enhancement — design §13 câu 4).
- Role-resolution open question §4 chốt: external principal **luôn** được JIT-upsert `userSites` membership (idempotent) nên `PermissionService` resolve role qua primary path.

**Verified:** recursive typecheck 15/15; verifier unit tests 12 (real RS256/ES256/HS256 — full skip/reject/accept decision tree); external-auth DB-integration 3 trên Postgres thật (issuer CRUD + duplicate reject, HS256-config reject, end-to-end token→site-role→JIT user+membership); migration 0042 applies cleanly trên fresh DB.
