# Design Document — External JWT Authentication

## Overview

Thiết kế cho **External JWT Authentication**: cho phép một site tin cậy JWT do IdP bên ngoài phát hành (Okta, Azure AD/Entra, Auth0, Logto, Keycloak, Cloudflare Access…) bằng cách validate chữ ký qua **JWKS tin cậy**, kiểm claim chuẩn (`iss`/`aud`/`exp`/`nbf`), ánh xạ claim→role (**default-deny**), resolve **đúng một site**, và (tùy chọn) JIT-provision user — **bỏ qua login nội bộ**.

Nguyên tắc thiết kế: **tổng quát hoá pattern đã có, không phát minh cơ chế mới**. Nhánh Cloudflare Access tại `apps/cms/src/middleware/auth.ts:125-159` đã chứng minh toàn bộ kỹ thuật cần thiết — `createRemoteJWKSet` + cache (`auth.ts:9-18`), `jwtVerify({ audience, algorithms })` (`auth.ts:139-142`), set `externalId: String(payload.sub)` (`auth.ts:145`). Feature này biến nó từ "một issuer hard-code (CF Access) cấp admin cho mọi người" thành "nhiều issuer cấu hình per-site, ánh xạ role tường minh, cô lập tenant". Đồng thời **sửa hai bug**: hard-code `roles: ['admin']` (`auth.ts:147`) và thiếu kiểm `siteId`.

Thư viện JWT: `jose` đã dùng sẵn (`routes/auth.ts:3`, `middleware/auth.ts:4`) — không thêm dependency.

## Architecture

```
   IdP bên ngoài (Okta / Entra / Auth0 / Logto / Keycloak …)
         │  phát hành External_JWT (RS256/ES256), expose JWKS
         ▼
   Client / service  ──►  Authorization: Bearer <External_JWT>
         │                 (X-Lumi-Site: <siteId>)
         ▼
┌──────────────────────────── CMS (Hono) ────────────────────────────┐
│  withTenant  → resolve siteId (header > subdomain > ?site dev-only)  │  tenant.ts:15-53
│  withAuth (middleware/auth.ts:78-289) — chuỗi xác thực:             │
│    0. dev-auth (dev:<email>:<role>)                  auth.ts:97-123  │
│    1. Cloudflare Access (cf-access-jwt-assertion)    auth.ts:125-159 │
│    2. Bearer present? ─┬─ a) API key (hash lookup)   auth.ts:166-218 │
│                        │                                             │
│                        ├─ b) ◀── NEW: ExternalJwtVerifier ──────┐    │
│                        │      decode iss/kid (unverified)        │    │
│                        │      match Trusted_Issuer_Set(siteId)   │    │
│                        │      jwtVerify(JWKS, {aud, alg-allow})  │    │
│                        │      validate exp/nbf/iss/aud + skew    │    │
│                        │      resolve site (claim|tenant) ==     │    │
│                        │      map claims→roles (default-deny)    │    │
│                        │      JIT provision (optional)           │    │
│                        │      set AuthPrincipal{externalId,roles}│    │
│                        │      iss matched + verify fail ⇒ 401 ◀──┘    │
│                        │      iss NOT matched ⇒ fall through ↓        │
│                        └─ c) custom JWT (HS256, internal)  auth.ts:229-275 │
│                              validate payload.siteId == requestSiteId      │
│                                                                     │
│  ── Admin surface ──                                                │
│  /api/v1/admin/auth/issuers  (CRUD)  → ExternalIssuerService        │
│        guard: PermissionService.bundle().admin  permission-service.ts:118 │
└───────────────┬─────────────────────────────────────────┬──────────┘
                ▼                                           ▼
   Postgres (Drizzle):                          runtime.cache (Rule #3):
     auth_external_issuers (NEW, per-site)        issuer-config TTL ≤ 60s
     users · userSites · roles  (core/access)     (JWKS cached by jose internally)
                ▲
                │ downstream: PermissionService.bundle() đọc userSites.roleId →
                │ roles.adminAccess/appAccess (permission-service.ts:236-245,361-365)
```

## 1. Tham chiếu requirements ↔ thiết kế (Traceability)

| Requirement | Component thiết kế |
|---|---|
| Req 1 (issuer config table) | §3 bảng `auth_external_issuers`, §4 Zod schema |
| Req 2 (admin CRUD) | §5 ExternalIssuerService + routes, §9 auth guard |
| Req 3 (signature/JWKS) | §6.2 verify-signature, §7 JWKS cache |
| Req 4 (claim validation) | §6.3 validate-claims (exp/nbf/iss/aud/skew) |
| Req 5 (site isolation) | §6.4 resolve-site, §10 threat model T3 |
| Req 6 (role mapping default-deny) | §6.5 map-roles, §8 role resolution, §10 T2 |
| Req 7 (chain position) | §6.1 verifier placement trong `withAuth` |
| Req 8 (JWKS cache/TTL/rotation) | §7 caching strategy |
| Req 9 (JIT provisioning) | §6.6 JIT, §3 users/userSites |
| Req 10 (no leak) | §10 logging/error policy |
| Req 11 (threat model) | §10 Security considerations |
| Req 12 (compat/env/migration) | §7 runtime abstraction, §11 migration |
| Req 13 (tests) | §12 test plan |
| Req 14 (setup impact) | §13 Setup Impact |

## 2. Quyết định lưu trữ: bảng DB vs env-only

**Quyết định v1: bảng `auth_external_issuers` (per-site, multi-tenant).** Lý do:

- **Multi-tenant**: env là toàn cục một instance; nhưng issuer phải gắn `site_id` để cô lập tenant (Req 5). Env không biểu diễn được "site A tin Okta-A, site B tin Entra-B".
- **Quản lý runtime**: admin bật/tắt/sửa ánh xạ qua API (Req 2) mà không redeploy/sửa secret store.
- **Nhất quán pattern**: giống cách `clickhouse-cdc` (registry #7) và `lumibase-firebase-sync` (#16) cấu hình pipeline per-site qua bảng + API, không qua env.

Tradeoff (xem Open Question 1): bảng phải qua chuỗi middleware tenant→auth để CRUD, và cần cache issuer-config (§7) để không query DB mỗi request. Env-only sẽ đơn giản hơn cho single-tenant nhưng đánh mất cô lập tenant — không chấp nhận được cho yêu cầu cốt lõi Req 5. Vì signature dùng **public** JWKS, bảng **không chứa secret** (Req 1.7), nên rủi ro lưu DB thấp.

## 3. Mô hình dữ liệu

### Bảng mới `auth_external_issuers` (per-site)

```
auth_external_issuers
  id                text  PK (nanoid)               -- CLAUDE.md Rule #1
  site_id           text  NOT NULL                  -- Rule #2 (FK sites.id, core.ts:25)
  issuer            text  NOT NULL                  -- khớp claim `iss`
  jwks_uri          text                            -- nullable (một trong jwks_uri/discovery_url)
  discovery_url     text                            -- OIDC .well-known
  audience          jsonb NOT NULL                  -- string | string[] kỳ vọng cho `aud`
  algorithms        jsonb NOT NULL                  -- allowlist, vd ["RS256","ES256"]
  claim_mapping     jsonb NOT NULL                  -- { email, roles, siteId?, externalId? }
  role_mapping      jsonb NOT NULL DEFAULT '{}'     -- { "<ext>": { roleId?|systemKey? } }
  default_role_id   text                            -- nullable, FK roles.id (cùng site)
  jit_provisioning  boolean NOT NULL DEFAULT false
  clock_skew_seconds integer NOT NULL DEFAULT 60    -- chặn trên 300 ở tầng app
  enabled           boolean NOT NULL DEFAULT true
  created_at        timestamptz NOT NULL DEFAULT now()
  updated_at        timestamptz NOT NULL DEFAULT now()

  UNIQUE (site_id, issuer)                          -- Req 1.3
  INDEX  (site_id, enabled)                         -- lookup Trusted_Issuer_Set
```

Không thêm cột vào bảng khác. Tái dùng:
- `users` (`core.ts:49`) — `external_id` đã tồn tại (CF Access set nó), JIT match/insert theo `external_id`.
- `userSites` (`core.ts:91`) — membership `(userId, siteId, roleId)`; primary role-resolution path (`permission-service.ts:239-245`).
- `roles` (`access.ts:26`) — có `systemKey` (`:36`), `adminAccess` (`:42`), `appAccess` (`:44`), unique `roles_site_system_key_unique` (`:50`) để phân giải `roleMapping` theo `systemKey`.

## 4. Zod schema — `packages/shared/src/schemas/external-issuer.ts`

- Export `ExternalIssuerConfigSchema` + type `ExternalIssuerConfig` (đặt ở `packages/shared` để CMS validate + Studio (tương lai: UI quản lý issuer) dùng chung — đúng quy ước `site-config.ts`/`extension-manifest.ts`).
- `algorithms`: `z.array(z.enum(['RS256','RS384','RS512','ES256','ES384','ES512'])).min(1)` — **không** có `HS*`/`none` trong enum (Req 2.3, 3.4).
- `claimMapping`: object `{ email: string, roles: string, siteId: string optional, externalId: string default 'sub' }`, `.strict()` để từ chối khoá lạ (Req 1.5).
- `roleMapping`: `z.record(z.object({ roleId: z.string().optional(), systemKey: z.string().optional() }).refine(at-least-one))`.
- URL fields: `.url()` + custom refine enforce `https://` (cho phép `http://localhost` khi `LUMIBASE_ENV=development`) (Req 2.4).
- `clockSkewSeconds`: `z.number().int().min(0).max(300).default(60)`.

## 5. ExternalIssuerService + routes (Req 2)

`apps/cms/src/services/external-issuer-service.ts` — CRUD scoped `siteId`:
- `list(siteId)`, `get(siteId, id)`, `create(siteId, input)`, `update(siteId, id, patch)`, `delete(siteId, id)`.
- `create`/`update` validate qua `ExternalIssuerConfigSchema`, enforce `(siteId, issuer)` unique → 409 `ISSUER_ALREADY_EXISTS`, audit qua `AuditLogger`.
- `getTrustedIssuers(siteId)` → các bản ghi `enabled=true`; dùng bởi verifier (qua cache §7).

`apps/cms/src/routes/admin-auth-issuers.ts` — router mount tại `/api/v1/admin/auth/issuers`:
- 5 handler CRUD, mỗi handler `requireAdmin(c)` (xem §9), trả `{ data }`/`{ errors }`.
- Mount cùng chỗ các route admin khác trong `index.ts`.

## 6. ExternalJwtVerifier flow — `apps/cms/src/modules/external-auth/verifier.ts`

### 6.1 Vị trí trong `withAuth` (Req 7)
Chèn một khối **giữa** nhánh API-key (`auth.ts:166-218`) và nhánh custom JWT (`auth.ts:229-275`), trong block `if (bearerToken)`:

```
if (bearerToken) {
  // (a) API key hash lookup … (giữ nguyên auth.ts:166-218)
  if (apiKey) { … return next(); }

  // (b) NEW: external JWT
  const result = await tryExternalJwt(c, bearerToken);  // §6.2-6.6
  if (result.kind === 'authenticated') { c.set('auth', result.principal); return next(); }
  if (result.kind === 'rejected')       return result.response;   // fail-closed (Req 7.3)
  // result.kind === 'skip' → iss không khớp issuer nào → rơi xuống (c)

  // (c) custom JWT (HS256, internal) … (giữ nguyên auth.ts:229-275)
}
```

`tryExternalJwt` trả union: `authenticated` | `rejected(response)` | `skip`. **`skip` chỉ khi** không decode được hoặc `iss` không khớp issuer nào trong Trusted_Issuer_Set (Req 7.4); một khi `iss` đã khớp, mọi lỗi → `rejected` (Req 7.3, fail-closed).

### 6.2 Decode + chọn issuer + verify chữ ký (Req 3)
1. Decode header/payload **không xác thực** (`jose.decodeJwt` / đọc protected header) chỉ để lấy `iss`, `kid`, `alg` — chưa tin gì (Req 7.5).
2. Lấy `Trusted_Issuer_Set(siteId)` từ cache (§7). Tìm config có `config.issuer === payload.iss`. Không có → `skip`.
3. Nếu `alg` không thuộc `config.algorithms` (hoặc là `none`/`HS*`) → `rejected` 401, audit `alg_not_allowed` (Req 3.2-3.4).
4. Lấy JWKS qua `getJwks(jwksUri)` (resolve `jwksUri` từ config hoặc OIDC discovery §7) — tái dùng `createRemoteJWKSet` (`auth.ts:11-18`).
5. `await jwtVerify(token, jwks, { issuer: config.issuer, audience: config.audience, algorithms: config.algorithms, clockTolerance: config.clockSkewSeconds })`. `jose` tự kiểm `exp`/`nbf`/`iss`/`aud` (Req 4) và chọn key theo `kid`. Lỗi (kid không khớp, chữ ký sai, hết hạn…) → map sang `rejected` + audit reason (Req 3.5, 3.6, 4.1-4.3).

### 6.3 Validate claim bổ sung (Req 4)
- `clockTolerance` truyền vào `jwtVerify` lo `exp`/`nbf`/`iat` skew (Req 4.5).
- `iat` quá xa tương lai: kiểm thủ công sau verify (Req 4.6) nếu vượt skew.
- `aud`/`iss`: `jose` enforce qua options; thiếu `aud` khi audience cấu hình → reject.

### 6.4 Resolve site (Req 5) — multi-tenant gate
- WHERE `config.claimMapping.siteId` set: đọc site từ claim đó. Nếu `claimSite !== requestSiteId` → `rejected` 403 `SITE_MISMATCH` (Req 5.2).
- WHERE không set: dùng `requestSiteId`. Vì `config` đã được chọn từ `Trusted_Issuer_Set(requestSiteId)` (lookup theo `site_id=requestSiteId` ở §6.2 bước 2), điều này tự động bảo đảm issuer được đăng ký *cho chính site đó* (Req 5.3). Token cùng `iss` ở site khác dùng config khác → cô lập (Req 5.5).
- **Không** đường nào resolve >1 site (Req 5.4).

### 6.5 Map claims → roles (default-deny) (Req 6)
1. Đọc raw roles từ claim `config.claimMapping.roles`; chuẩn hoá string | string[] | "a b c"/"a,b,c" → `string[]`.
2. Với mỗi giá trị, tra `config.roleMapping[value]`. Thu các `{roleId|systemKey}` ánh xạ được.
3. Phân giải mỗi reference sang `roles` của site: theo `roleId` (eq `roles.id` + `site_id`) hoặc `systemKey` (qua `roles_site_system_key_unique`). Bỏ qua reference trỏ role đã xoá + log-once (Req 6.6).
4. Nếu rỗng VÀ `config.defaultRoleId` set → dùng default role (Req 6.4). Nếu vẫn rỗng → `rejected` 403 `NO_ROLE_MAPPING` (Req 6.3). **Không bao giờ** hard-code `['admin']`.
5. Đặt `AuthPrincipal.roles = [resolvedRoleId, …]`. **Tầng verifier không tự tính admin** — `PermissionService.bundle()` đọc role của principal và suy `adminAccess`/`appAccess` từ `roles.adminAccess` (`permission-service.ts:236-245,361-365`) (Req 6.5, 6.7).

> Lưu ý tích hợp: hiện `withAuth` đặt `roles` là mảng *role-id/strings*; `PermissionService` resolve quyền từ `userSites.roleId` (primary). Với external principal **không** có `userSites` (khi JIT tắt nhưng user pre-provisioned qua SCIM), cần xác nhận `PermissionService` cũng đọc role qua `userRoles`/membership tương ứng. Xem Open Question 4.

### 6.6 JIT provisioning (Req 9)
- Match `users` theo `external_id`. Có & `active` → dùng `users.id`. Có & không active → `rejected` 401 (Req 9.5).
- Không có:
  - `jitProvisioning=false` → `rejected` 403 `USER_NOT_PROVISIONED` (Req 9.1).
  - `jitProvisioning=true` → insert `users` (nanoid, `external_id`, email từ claim, `status='active'`) `onConflictDoNothing(external_id)`; upsert `userSites(userId, siteId, roleId=resolved)`; audit `external_user_provisioned` (Req 9.2-9.4, 9.6).
- Dựng `AuthPrincipal { type:'user', userId, externalId, email, roles, raw: payload }`.

## 7. JWKS & issuer-config caching (Req 8, 12)

- **JWKS**: tái dùng `JWKS_CACHE` + `getJwks` (`auth.ts:9-18`) — `createRemoteJWKSet` tự cache key trong bộ nhớ và tự refetch khi gặp `kid` lạ (với cooldown nội bộ của `jose`). Đủ cho Req 8.1-8.2. Bổ sung: bọc thêm rate-limit/cooldown per `jwksUri` nếu cần chặn storm (Req 8.3), và timeout fetch (Req 8.4).
- **OIDC discovery**: nếu config dùng `discoveryUrl`, fetch `.well-known/openid-configuration` → lấy `jwks_uri` + validate `issuer` khớp; cache kết quả TTL riêng qua `runtime.cache` (Req 8.5).
- **Issuer-config**: cache `getTrustedIssuers(siteId)` qua `c.get('runtime').cache` key `auth:issuers:<siteId>` TTL ≤ 60s (Req 8.6) — **runtime abstraction** (Rule #3), chạy ở cả CF Workers và Node/Docker (Req 12.1). PATCH/DELETE invalidate key này (hoặc để TTL ngắn tự hết).
- Fail-closed: lỗi fetch JWKS/discovery mà không có cache hợp lệ → reject 401 (Req 3.6, 8.4).

## 8. Role resolution downstream

External principal sau verify có `AuthPrincipal.roles` chứa LumiBase role-id. Đường đi quyền:
- JIT/pre-provisioned user có `userSites(userId, siteId, roleId)` → `PermissionService` primary path (`permission-service.ts:239-245`) đọc `roles.adminAccess`/`appAccess` → `bundle().admin` (`:361-362`).
- Admin chỉ khi role được ánh xạ có `adminAccess=true` — không có cửa hậu (Req 6.7, 11.4).

## 9. Auth guard cho admin endpoints (Req 2.2)

`requireAdmin(c)` dùng `PermissionService` của request: lấy `bundle()` (`permission-service.ts:118`), nếu `!bundle.admin` → 403 `FORBIDDEN`. Cùng cơ chế các route admin hiện có. Lưu ý: chính các endpoint admin issuer cũng được bảo vệ bởi `withAuth` — tức admin phải tự xác thực bằng một path hợp lệ (CF Access/custom JWT/—về lý thuyết—external JWT đã cấu hình) trước khi quản lý issuer.

## 10. Security considerations

Đây là feature **nhạy cảm bảo mật** vì nó *bypass internal auth*. Threat model:

- **T1 — Token giả mạo / sai chữ ký.** Phòng: chữ ký bắt buộc verify bằng JWKS **public** của issuer đã đăng ký (Req 3.1); fail-closed khi không lấy được JWKS (Req 3.6); `alg:none` bị chặn tuyệt đối (Req 3.3).
- **T2 — Leo thang quyền (mọi token thành admin).** Đây là bug của nhánh CF Access (`auth.ts:147`). Phòng: **default-deny** — không ánh xạ role → 403 `NO_ROLE_MAPPING` (Req 6.3); admin chỉ qua Role_Mapping tới role `adminAccess=true` (Req 6.7); verifier không tự suy admin (Req 6.5).
- **T3 — Cross-tenant (token site A dùng cho site B).** Phòng: config chọn từ `Trusted_Issuer_Set(requestSiteId)`; `claimMapping.siteId` (nếu có) phải khớp request site (Req 5.2); cùng `iss` ở hai site là hai config độc lập (Req 5.5); không bao giờ resolve >1 site (Req 5.4).
- **T4 — Key/alg confusion (RS256→HS256).** Phòng: allowlist **chỉ bất đối xứng** (Req 2.3, 3.4); `HS*` bị từ chối cho external; verify nội bộ HS256 (`auth.ts:21-28`) nằm ở nhánh khác và độc lập (Req 11.6).
- **T5 — Token bị thu hồi / issuer bị gỡ vẫn dùng được.** Phòng: disable/delete issuer có hiệu lực trong TTL issuer-config ≤ 60s (Req 8.6, 11.5). (External token tự nó vẫn hợp lệ tới `exp` — đây là giới hạn của bearer JWT; mitigations: TTL ngắn phía IdP; v2 có thể introspection/denylist — Open Question 3.)
- **T6 — Rò rỉ qua log.** Phòng: không bao giờ log raw token; chỉ `iss`/`kid`/reason; `formatSafeError` (`auth.ts:7,153,277`) (Req 10).
- **T7 — DoS (JWKS storm / JWT bomb).** Phòng: cooldown refetch JWKS per URL (Req 8.3); timeout fetch (Req 8.4); giới hạn kích thước token + độ lớn claim (Req 11.7).
- **T8 — Phân biệt lỗi giúp dò.** Phòng: response dùng mã chung (`UNAUTHENTICATED`/`FORBIDDEN`), chi tiết chỉ vào audit/server log (Req 10.2).
- **T9 — `iss` không khớp âm thầm fallback và bị custom-JWT chấp nhận.** Phòng: `skip` chỉ khi `iss` không khớp; một khi khớp issuer → fail-closed, không fallback (Req 7.3-7.4).

Bảng quyết định "skip vs reject":

| Tình huống | Hành vi |
|---|---|
| Token không decode được / không có `iss` | `skip` → thử custom JWT |
| `iss` không khớp issuer nào của site | `skip` → thử custom JWT |
| `iss` khớp, nhưng `alg`/chữ ký/`aud`/`exp` sai | `rejected` 401 (fail-closed) |
| `iss` khớp, chữ ký OK, nhưng không map được role | `rejected` 403 `NO_ROLE_MAPPING` |
| `iss` khớp, role OK, site claim ≠ request site | `rejected` 403 `SITE_MISMATCH` |
| `iss` khớp, hợp lệ, user chưa có & JIT off | `rejected` 403 `USER_NOT_PROVISIONED` |

## 11. Migration (Req 12.5)

- Viết tay `packages/database/drizzle/0032_auth_external_issuers.sql` (kế tiếp `0031_regulated_content_readiness.sql`), `CREATE TABLE IF NOT EXISTS auth_external_issuers (...)` + indexes, idempotent.
- Sửa `packages/database/drizzle/meta/_journal.json` thêm entry `0032` (theo memory "Migrations are hand-written" — **không** `drizzle-kit generate`).
- Thêm table định nghĩa Drizzle vào `packages/database/src/schema/` (vd `access.ts` hoặc file mới `external-auth.ts`) + export trong `schema/index.ts`.

## 12. Test plan (Req 13)

- **Unit verifier** (`verifier.test.ts`): ký JWT test bằng RS256/ES256 (jose `generateKeyPair`); cây quyết định §10 (accept hợp lệ; reject `alg:none`/`HS256`/sai `aud`/sai `iss`/hết `exp`/`nbf` tương lai/`kid` lạ).
- **Multi-tenant** (`verifier.test.ts`): token site A + `X-Lumi-Site:B` → reject (Req 13.2).
- **Role mapping**: default-deny → 403; map→admin role → principal admin qua PermissionService; không path hard-code admin (Req 13.3).
- **JIT**: on → tạo user+membership idempotent; off → 403 (Req 13.4).
- **Chain**: API key ưu tiên; non-JWT bearer → fallback custom; `iss` khớp + verify fail → không fallback (Req 13.5).
- **Admin CRUD** (integration): tạo/sửa/xoá, enforce admin, reject `HS256` trong `algorithms` (Req 13.6).

## 13. Setup Impact (Req 14)

Rà soát 6 câu hỏi:
1. Seed? **Không** — `auth_external_issuers` rỗng khi khởi tạo; issuer do admin đăng ký theo nhu cầu (giống `clickhouse-cdc` #7, `lumibase-firebase-sync` #16).
2. Settings key bắt buộc? **Không** — cấu hình sống trong bảng, không env mới bắt buộc (Req 12.3).
3. Policy/grant DB mặc định? **Không** — admin endpoints gated bằng `adminAccess` sẵn có; external principal lấy quyền từ Role_Mapping → roles hiện hữu.
4. Bước UI wizard? **Không** — issuer cấu hình sau setup qua admin API (Studio UI là enhancement sau).
5. Capability flag `/setup/capabilities`? **Không**.
6. Backfill? **Không** — migration chỉ `CREATE TABLE IF NOT EXISTS`; instance cũ không có issuer → nhánh external `skip` mọi token → hành vi auth hiện tại (CF Access/custom JWT) giữ nguyên.

Kết quả dự kiến: ghi **`n/a`** vào Registry với ngày rà soát + lý do (bảng mới nhưng không seed/flag/wizard/capability/backfill).

## 14. Open questions

1. **Bảng vs env cho issuer config.** *Chốt v1: bảng `auth_external_issuers`* (multi-tenant, manageable, không chứa secret vì JWKS public). Tradeoff: cần cache issuer-config (§7) tránh query mỗi request. Env-only đơn giản hơn cho single-tenant nhưng phá Req 5 (cô lập tenant) — loại.
2. **CF Access nên giữ riêng hay gộp thành một issuer external?** *Chốt v1: giữ nhánh CF Access (`auth.ts:125-159`) nguyên trạng để tránh regression* (Req 12.2); nhưng vẫn **nên sửa bug hard-code admin** của nó như một sub-task (hoặc tối thiểu ghi chú). v2 cân nhắc mô tả CF Access như issuer external có `claimMapping`/`roleMapping` để gỡ `roles:['admin']`.
3. **Thu hồi token trước `exp`?** Bearer JWT không revoke được tự nhiên. v1 dựa vào TTL ngắn phía IdP + disable issuer (TTL ≤ 60s). v2 cân nhắc OIDC introspection hoặc denylist `jti`. — *để v2.*
4. **Role resolution cho external principal không có `userSites`.** Cần đọc chữ ký thực `PermissionService` lúc implement: principal external (pre-provisioned qua SCIM, JIT off) có thể có membership qua `userSites` hoặc `userRoles`. Nếu verifier đặt `roles` là role-id mà PermissionService kỳ vọng resolve qua `userSites.roleId`, cần bảo đảm membership tồn tại — hoặc JIT upsert `userSites` ngay cả khi user đã tồn tại. — *Quyết định lúc implement; ưu tiên: external principal luôn có `userSites` cho site (JIT-upsert membership idempotent).*
5. **Một token map nhiều role.** v1 cho phép `roleMapping` trả nhiều role; PermissionService đã hợp nhất nhiều role (`roleRows.some(adminAccess)`). Không có open issue — chỉ xác nhận khi viết test.
