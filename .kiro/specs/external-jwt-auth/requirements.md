# Requirements Document

## Introduction

Tài liệu yêu cầu cho **External JWT Authentication** trong LumiBase — khả năng cho phép một site xác thực người dùng và service bằng **JWT do bên thứ ba phát hành** (Identity Provider — Okta, Azure AD / Entra ID, Auth0, Logto, Keycloak, Cloudflare Access, …) thông qua việc **validate chữ ký bằng JWKS tin cậy**, trích xuất claim, ánh xạ role, và thiết lập principal — **bỏ qua (bypass) luồng login nội bộ** mà không cần biết mật khẩu hay phát hành JWT nội bộ. Đây là parity với Directus External Authentication / OpenID provider, nhưng theo mô hình multi-tenant của LumiBase.

LumiBase **đã có một template trưởng thành một phần** cho mô hình này: middleware auth tại `apps/cms/src/middleware/auth.ts:125-159` đã có nhánh **Cloudflare Access JWT** — nó validate RS256 qua JWKS từ `CF_ACCESS_CERTS_URL`, kiểm `audience` bằng `CF_ACCESS_AUDIENCE`, set `externalId: String(payload.sub)`, và cache JWKS qua `createRemoteJWKSet` (`auth.ts:9-18`). Feature này **tổng quát hoá đúng pattern đó** cho một hay nhiều external issuer cấu hình được, đồng thời **sửa hai khiếm khuyết bảo mật của nhánh CF Access hiện tại**:

1. Nó **hard-code `roles: ['admin']`** (`auth.ts:147`) cho mọi token Access hợp lệ — tức bất kỳ ai vượt qua được Access đều thành admin, không trích xuất role từ claim. Feature mới **không bao giờ hard-code admin**; mặc định **default-deny** nếu không có ánh xạ role tường minh.
2. Nhánh CF Access **không validate `siteId`** (nó được coi là admin-only, single-tenant). Feature mới **bắt buộc** mỗi external JWT resolve về **đúng một site**; token cho site A **không bao giờ** được cấp quyền vào site B.

Hiện trạng (gap):
- Thư viện JWT là `jose` (`SignJWT` để ký nội bộ tại `apps/cms/src/routes/auth.ts:3,115-123`; `jwtVerify` + `createRemoteJWKSet` để verify tại `middleware/auth.ts:4`). **Không cần thêm dependency.**
- Login nội bộ phát JWT **HS256** payload `{ userId, email, roles, siteId }`, ký bằng `JWT_SECRET`, hết hạn 24h (`routes/auth.ts:118-122`). Verify nội bộ tại `middleware/auth.ts:21-28,229-275`: thử **API key** trước (hash SHA-256, lookup DB — `auth.ts:166-218`), rồi fallback `verifyCustomJwt()` (HS256), validate `payload.siteId === requestSiteId` (`auth.ts:231-238`), lookup user `status='active'` (`auth.ts:241-252`).
- **Chưa có cấu hình external issuer nào.** Env hiện có: `JWT_SECRET`, `CF_ACCESS_CERTS_URL`, `CF_ACCESS_AUDIENCE`, `SCIM_TOKEN`, `LUMIBASE_DEV_AUTH`, `LUMIBASE_ENV` (`apps/cms/src/env.ts:19,44-50`). Không có khái niệm issuer tin cậy đa-tenant.
- SCIM (`apps/cms/src/routes/scim.ts`, `scim-admin.ts`) provision user qua `SCIM_TOKEN`, map SCIM group → `teams`, tạo `userSites` membership với roleId mặc định — **không có group→role mapping**. External JWT auth bổ trợ SCIM: SCIM lo *provisioning*, external JWT lo *authentication runtime*.
- Role resolution per-site qua `apps/cms/src/services/permission-service.ts`: ưu tiên `userSites.roleId` (primary, `permission-service.ts:239-245`), `userRoles` (secondary, `:257-263`), `apiKeyRoles` (`:272-281`); role có `adminAccess`/`appAccess`/`systemKey` (`access.ts:36,42,44`).

Phạm vi feature: validate external JWT, ánh xạ claim→role, resolve site an toàn, optional JIT provisioning, và CRUD admin cho issuer config. **Ngoài phạm vi:** OAuth2/OIDC *authorization-code login flow* phía Studio (feature riêng — đây chỉ là **bearer-token verification**, IdP login UI nằm ngoài), refresh-token rotation cho external token (IdP sở hữu vòng đời token), và SCIM provisioning (đã có).

## Glossary

- **CMS**: Backend Hono tại `apps/cms` phục vụ REST API ở prefix `/api/v1`.
- **External_JWT**: JWT do một Identity Provider bên ngoài phát hành, trình bày tới CMS dưới dạng `Authorization: Bearer <token>` (hoặc header riêng của một số IdP, vd `cf-access-jwt-assertion`). Không do LumiBase ký.
- **Issuer / IdP**: Hệ thống phát hành External_JWT (Okta, Azure AD / Entra ID, Auth0, Logto, Keycloak, Cloudflare Access…). Định danh bằng claim `iss`.
- **External_Issuer_Config**: Bản ghi cấu hình một issuer tin cậy cho một site: `issuer` (URL khớp claim `iss`), JWKS URI hoặc OIDC discovery URL, `audience` kỳ vọng, danh sách thuật toán cho phép (allowlist), `Claim_Mapping`, `Role_Mapping`, chính sách provisioning. Lưu ở bảng `auth_external_issuers` (multi-tenant, per-site).
- **JWKS**: JSON Web Key Set — tập public key của issuer dùng để verify chữ ký, lấy qua HTTP từ JWKS URI; có `kid` để chọn key. Được cache với TTL.
- **OIDC_Discovery**: Tài liệu `.well-known/openid-configuration` của issuer, từ đó suy ra `jwks_uri` và `issuer`. Tùy chọn thay cho việc khai báo JWKS URI trực tiếp.
- **Claim_Mapping**: Cấu hình ánh xạ claim → thuộc tính LumiBase: claim nào chứa `email`, claim nào chứa danh sách `roles`, claim nào (tùy chọn) chứa `siteId`, claim nào dùng làm `externalId` (mặc định `sub`).
- **Role_Mapping**: Bảng ánh xạ giá trị role claim bên ngoài (vd `"editors"`, `"crm-admins"`) → LumiBase role (theo `roles.id` hoặc `roles.systemKey`, vd `administrator`, `public`). **Default-deny**: claim không có ánh xạ → không cấp role.
- **External_Auth_Verifier**: Thành phần trong CMS (mở rộng `withAuth`) nhận một bearer token, nhận diện issuer qua `iss`, match với External_Issuer_Config cho site của request, validate chữ ký + claim, dựng `AuthPrincipal`.
- **Trusted_Issuer_Set**: Tập External_Issuer_Config `enabled=true` thuộc về `site_id` của request hiện tại; chỉ những issuer trong tập này được tin cho request đó.
- **JIT_Provisioning**: Just-In-Time — tạo bản ghi `users` + `userSites` lần đầu một External_JWT hợp lệ xuất hiện cho một subject chưa tồn tại, ánh xạ `externalId`. Bật/tắt per-issuer.
- **AuthPrincipal**: Cấu trúc principal mỗi request tại `apps/cms/src/env.ts:92-110` — `{ type?, externalId?, userId?, email?, roles?, isFrontendUser?, raw }`. External_Auth_Verifier điền `externalId`, `roles`, `email`, `raw`.
- **Clock_Skew**: Dung sai lệch đồng hồ (giây) cho `exp`/`nbf`/`iat` khi verify, để chịu lệch giờ giữa IdP và CMS.
- **Audit_Log**: Bảng/ghi sự kiện bảo mật, qua `AuditLogger` (`apps/cms/src/modules/audit/logger.ts`), tái dùng pattern `api_key_use_denied` (`middleware/auth.ts:49-69`).

## Requirements

### Requirement 1: Cấu hình external issuer tin cậy (per-site)

**User Story:** Là một admin của một site, tôi muốn đăng ký một hay nhiều IdP bên ngoài tin cậy cho site của mình, để người dùng và service của tổ chức tôi truy cập LumiBase bằng JWT có sẵn mà không cần tài khoản nội bộ riêng.

#### Acceptance Criteria

1. THE CMS SHALL lưu External_Issuer_Config trong bảng multi-tenant `auth_external_issuers` với tối thiểu các cột: `id` (nanoid), `siteId`, `issuer` (text, khớp claim `iss`), `jwksUri` (text, nullable), `discoveryUrl` (text, nullable), `audience` (text/json), `algorithms` (json — allowlist), `claimMapping` (json), `roleMapping` (json), `jitProvisioning` (boolean default false), `defaultRoleId` (text nullable), `enabled` (boolean default true), `clockSkewSeconds` (int default 60), `createdAt`/`updatedAt`.
2. THE External_Issuer_Config SHALL yêu cầu ít nhất một trong `jwksUri` hoặc `discoveryUrl`; WHEN cả hai đều thiếu, THE CMS SHALL từ chối tạo với HTTP 422 `{ errors: [{ code: 'JWKS_SOURCE_REQUIRED' }] }`.
3. THE CMS SHALL bắt buộc `(siteId, issuer)` là duy nhất; WHEN tạo issuer trùng `(siteId, issuer)`, THE CMS SHALL từ chối với HTTP 409 `{ errors: [{ code: 'ISSUER_ALREADY_EXISTS' }] }`.
4. THE CMS SHALL scope mọi truy vấn issuer theo `site_id` của request; một site SHALL không bao giờ đọc/sửa/xoá issuer của site khác (Strict Rule #2 — `apps/cms/src/middleware/tenant.ts:15-53`).
5. WHERE field `claimMapping` được lưu, THE CMS SHALL chấp nhận các khoá `email`, `roles`, `siteId` (optional), `externalId` (mặc định `sub`), mỗi giá trị là một JSON-path/claim-name; validate bằng Zod, từ chối khoá lạ.
6. THE External_Issuer_Config SHALL lưu `roleMapping` dưới dạng map từ giá trị role-claim bên ngoài → LumiBase role reference (`{ "<external_value>": { "roleId"?: string, "systemKey"?: string } }`).
7. THE CMS SHALL KHÔNG lưu bất kỳ secret nào của IdP trong `auth_external_issuers` (signature dùng public JWKS — không có client secret); WHERE một trường có vẻ là secret được gửi lên, THE CMS SHALL bỏ qua nó.

### Requirement 2: Admin CRUD cho issuer config

**User Story:** Là một admin, tôi muốn quản lý cấu hình issuer qua API, để bật/tắt và chỉnh ánh xạ mà không cần redeploy hay sửa env.

#### Acceptance Criteria

1. THE CMS SHALL expose `POST /api/v1/admin/auth/issuers` (tạo), `GET /api/v1/admin/auth/issuers` (liệt kê), `GET /api/v1/admin/auth/issuers/:id` (đọc), `PATCH /api/v1/admin/auth/issuers/:id` (cập nhật), `DELETE /api/v1/admin/auth/issuers/:id` (xoá), tất cả trả `{ data }` / `{ errors }`.
2. THE issuer admin endpoints SHALL yêu cầu principal có `adminAccess=true` (qua `PermissionService.bundle()` — `permission-service.ts:118,361-362`); request không đủ quyền trả HTTP 403 `{ errors: [{ code: 'FORBIDDEN' }] }`.
3. WHEN một issuer được tạo hoặc cập nhật, THE CMS SHALL validate `algorithms` chỉ chứa giá trị thuộc allowlist `{ RS256, RS384, RS512, ES256, ES384, ES512 }`; WHEN chứa `HS256`/`HS384`/`HS512`/`none` hoặc giá trị ngoài tập, THE CMS SHALL từ chối với HTTP 422 `{ errors: [{ code: 'ALGORITHM_NOT_ALLOWED' }] }`.
4. WHEN một issuer được tạo/cập nhật, THE CMS SHALL validate cú pháp `issuer`, `jwksUri`, `discoveryUrl` là URL `https://` hợp lệ (trừ môi trường `LUMIBASE_ENV=development` cho phép `http://localhost`); URL không hợp lệ → HTTP 422 `{ errors: [{ code: 'INVALID_URL' }] }`.
5. THE issuer admin response (GET/list) SHALL trả cấu hình đầy đủ trừ không kèm bất kỳ giá trị nhạy cảm nào; SHALL không bao giờ trả raw token hay nội dung JWKS key vật liệu private.
6. WHEN một issuer bị xoá hoặc đặt `enabled=false`, THE External_Auth_Verifier SHALL ngừng tin token từ issuer đó cho site đó kể từ request kế tiếp (sau khi cache issuer-config hết hạn theo TTL ở Req 8.6).
7. WHEN một issuer được tạo, cập nhật, hoặc xoá, THE CMS SHALL ghi Audit_Log (`external_issuer_created` / `external_issuer_updated` / `external_issuer_deleted`) với metadata `{ issuer, siteId }` — KHÔNG kèm token hay nội dung claim.

### Requirement 3: Validate chữ ký qua JWKS tin cậy

**User Story:** Là một kỹ sư bảo mật, tôi muốn chữ ký mọi external JWT được validate bằng public key lấy từ JWKS của chính issuer, để không token giả mạo nào được chấp nhận.

#### Acceptance Criteria

1. THE External_Auth_Verifier SHALL validate chữ ký bằng `jose.jwtVerify` với key set lấy qua `jose.createRemoteJWKSet` từ `jwksUri` của issuer (hoặc `jwks_uri` suy ra từ OIDC_Discovery), tái dùng đúng cơ chế của nhánh CF Access (`middleware/auth.ts:9-18,139-142`).
2. THE External_Auth_Verifier SHALL truyền `algorithms` allowlist của issuer vào `jwtVerify`; token ký bằng thuật toán ngoài allowlist SHALL bị từ chối với HTTP 401 `{ errors: [{ code: 'UNAUTHENTICATED' }] }`.
3. THE External_Auth_Verifier SHALL từ chối token có header `alg: none` (unsigned) trong mọi trường hợp.
4. THE External_Auth_Verifier SHALL từ chối token ký bằng thuật toán đối xứng (`HS256`/`HS384`/`HS512`) cho external issuer — external auth chỉ chấp nhận chữ ký bất đối xứng; việc này tách biệt hoàn toàn với verify nội bộ HS256 (`middleware/auth.ts:21-28`).
5. WHEN JWKS không chứa key khớp `kid` của token (hoặc token thiếu `kid` mà JWKS có nhiều key), THE External_Auth_Verifier SHALL từ chối với HTTP 401 và ghi lý do `jwks_kid_unmatched` vào Audit_Log (không kèm token).
6. WHEN không lấy được JWKS (network/HTTP lỗi) và không có bản cache còn hạn, THE External_Auth_Verifier SHALL từ chối request với HTTP 401 (fail-closed) và ghi `jwks_fetch_failed`; SHALL không bao giờ chấp nhận token khi không thể verify chữ ký.

### Requirement 4: Validate claim chuẩn (exp, nbf, iss, aud)

**User Story:** Là một kỹ sư bảo mật, tôi muốn mọi claim thời gian và định danh được kiểm chặt, để token hết hạn, chưa hiệu lực, hoặc sai đối tượng đều bị từ chối.

#### Acceptance Criteria

1. THE External_Auth_Verifier SHALL từ chối token có `exp` đã qua (sau khi áp Clock_Skew) với HTTP 401 `{ errors: [{ code: 'TOKEN_EXPIRED' }] }`.
2. THE External_Auth_Verifier SHALL từ chối token có `nbf` (not-before) trong tương lai vượt Clock_Skew với HTTP 401 `{ errors: [{ code: 'UNAUTHENTICATED' }] }`.
3. THE External_Auth_Verifier SHALL validate claim `aud` khớp `audience` cấu hình của issuer; WHEN `aud` không khớp (hoặc thiếu khi audience được cấu hình), THE verifier SHALL từ chối với HTTP 401.
4. THE External_Auth_Verifier SHALL validate claim `iss` khớp chính xác (so sánh tường minh) trường `issuer` của External_Issuer_Config; WHEN `iss` thiếu hoặc không khớp issuer nào trong Trusted_Issuer_Set của site, THE verifier SHALL bỏ qua nhánh external và chuyển sang nhánh kế tiếp (không tự ý chấp nhận).
5. THE External_Auth_Verifier SHALL áp Clock_Skew tối đa từ `clockSkewSeconds` của issuer (mặc định 60s, chặn trên ≤ 300s) cho mọi kiểm `exp`/`nbf`/`iat`.
6. WHERE token mang claim `iat`, THE External_Auth_Verifier SHALL từ chối token có `iat` quá xa trong tương lai vượt Clock_Skew (chống token rõ ràng dị thường).

### Requirement 5: Resolve site an toàn (multi-tenant isolation)

**User Story:** Là một người vận hành multi-tenant, tôi muốn một external JWT chỉ cấp quyền cho đúng một site, để token của khách hàng A không bao giờ chạm dữ liệu khách hàng B.

#### Acceptance Criteria

1. THE External_Auth_Verifier SHALL resolve External_JWT về **đúng một** `site_id`; principal kết quả SHALL chỉ có hiệu lực trong site đó.
2. WHERE `claimMapping.siteId` được cấu hình, THE External_Auth_Verifier SHALL lấy site từ claim đó VÀ SHALL từ chối (HTTP 403 `{ errors: [{ code: 'SITE_MISMATCH' }] }`) nếu site trong claim khác `siteId` của request (`middleware/tenant.ts:15-53`).
3. WHERE `claimMapping.siteId` KHÔNG được cấu hình, THE External_Auth_Verifier SHALL dùng `siteId` của request (từ tenant middleware) VÀ SHALL chỉ tin token nếu issuer của nó đã được đăng ký (`enabled=true`) **cho chính site đó** (`auth_external_issuers.siteId === requestSiteId`).
4. THE External_Auth_Verifier SHALL KHÔNG bao giờ resolve một External_JWT sang nhiều site, hoặc sang site mà issuer của token chưa được đăng ký; vi phạm SHALL dẫn tới HTTP 401/403, không bao giờ degrade thành "chấp nhận một phần".
5. WHEN cùng một giá trị `issuer` được đăng ký ở hai site khác nhau, THE External_Auth_Verifier SHALL coi chúng là hai cấu hình độc lập và chỉ dùng cấu hình thuộc `siteId` của request — token cho site A SHALL không bao giờ được verify bằng cấu hình (audience/role-mapping) của site B.

### Requirement 6: Ánh xạ claim → LumiBase role (default-deny)

**User Story:** Là một admin, tôi muốn role trong token của IdP được ánh xạ tường minh sang role LumiBase, để quyền được kiểm soát đúng và không ai vô tình thành admin.

#### Acceptance Criteria

1. THE External_Auth_Verifier SHALL đọc role bên ngoài từ claim chỉ định bởi `claimMapping.roles` (chấp nhận giá trị là chuỗi đơn, mảng chuỗi, hoặc chuỗi phân tách space/comma — chuẩn hoá thành mảng).
2. THE External_Auth_Verifier SHALL ánh xạ mỗi giá trị role bên ngoài sang LumiBase role qua `roleMapping`; chỉ những giá trị có entry trong `roleMapping` mới sinh role — **default-deny** (Req nhấn mạnh: KHÔNG hard-code `['admin']` như `middleware/auth.ts:147`).
3. WHEN không có giá trị role nào ánh xạ được VÀ issuer không có `defaultRoleId`, THE External_Auth_Verifier SHALL từ chối request với HTTP 403 `{ errors: [{ code: 'NO_ROLE_MAPPING' }] }` (principal không được dựng).
4. WHERE issuer có `defaultRoleId`, THE External_Auth_Verifier SHALL dùng role đó khi không claim role nào ánh xạ được; `defaultRoleId` SHALL trỏ tới một `roles.id` tồn tại trong cùng site.
5. THE External_Auth_Verifier SHALL phân giải role reference (`roleId`/`systemKey`) sang `roles` của site qua chỉ mục `roles_site_system_key_unique` (`access.ts:50`) và đặt kết quả vào `AuthPrincipal.roles`, để `PermissionService` tính `adminAccess`/`appAccess` từ chính role đó (`permission-service.ts:236-245,361-365`) — KHÔNG tự suy quyền admin tại tầng verifier.
6. WHEN một giá trị `roleMapping` trỏ tới role không tồn tại trong site (đã bị xoá), THE External_Auth_Verifier SHALL bỏ qua entry đó và log warning một lần per cache-window; nếu kết quả là rỗng → áp Req 6.3 (default-deny).
7. THE External_Auth_Verifier SHALL KHÔNG bao giờ nâng một principal external lên `adminAccess` trừ khi role được ánh xạ tường minh có `roles.adminAccess=true`.

### Requirement 7: Vị trí nhánh external trong chuỗi verify

**User Story:** Là một maintainer, tôi muốn nhánh external JWT nằm đúng vị trí trong chuỗi xác thực hiện có, để không phá API key, CF Access, hay custom JWT.

#### Acceptance Criteria

1. THE External_Auth_Verifier SHALL được đặt trong `withAuth` (`middleware/auth.ts:78-289`) **sau** nhánh API-key (`auth.ts:166-218`) và nhánh Cloudflare Access (`auth.ts:125-159`), **trước** nhánh custom JWT nội bộ (`auth.ts:229-275`).
2. WHEN một bearer token là API key hợp lệ (lookup hash thành công — `auth.ts:166-172`), THE chain SHALL dùng nhánh API key và KHÔNG chạy External_Auth_Verifier.
3. WHEN một bearer token có claim `iss` khớp một issuer trong Trusted_Issuer_Set của site, THE chain SHALL dùng External_Auth_Verifier và KHÔNG fallback sang custom JWT nội bộ (kể cả khi external verify fail — fail-closed cho token có chủ đích external).
4. WHEN một bearer token KHÔNG decode được phần header/payload (không phải JWT) HOẶC `iss` không khớp issuer nào, THE chain SHALL chuyển sang nhánh custom JWT nội bộ như hiện tại (`auth.ts:229-275`) — bảo toàn hành vi cũ.
5. THE External_Auth_Verifier SHALL decode header/payload **không xác thực** chỉ để đọc `iss`/`kid` nhằm chọn issuer config; SHALL không tin bất kỳ claim nào trước khi `jwtVerify` thành công.
6. THE thay đổi SHALL không ảnh hưởng các path bỏ qua auth hiện có (`/auth/login`, `/auth/register`, `/realtime`, `/files/upload/*` — `auth.ts:80-87`) và không đổi hành vi dev-auth (`auth.ts:97-123`).

### Requirement 8: Cache JWKS, TTL và rotation

**User Story:** Là một người vận hành, tôi muốn JWKS được cache và làm mới đúng cách, để không gọi IdP mỗi request nhưng vẫn nhận được key mới sau khi IdP xoay khoá.

#### Acceptance Criteria

1. THE External_Auth_Verifier SHALL cache JWKS theo `jwksUri` (qua `createRemoteJWKSet`, vốn tự quản cache nội bộ — `middleware/auth.ts:9-18`) và SHALL không gọi mạng để lấy JWKS trên mọi request khi cache còn hạn.
2. WHEN token mang `kid` không có trong JWKS đã cache, THE verifier SHALL kích hoạt một lần refetch JWKS (cooldown) để bắt kịp rotation; nếu vẫn không khớp → từ chối (Req 3.5).
3. THE External_Auth_Verifier SHALL áp một cooldown/rate-limit cho việc refetch JWKS theo mỗi `jwksUri` (vd tối thiểu N giây giữa hai lần fetch) để một loạt token `kid` lạ không gây storm request tới IdP.
4. THE External_Auth_Verifier SHALL set timeout hợp lý cho HTTP fetch JWKS/discovery và xử lý lỗi fetch theo Req 3.6 (fail-closed).
5. WHERE issuer dùng `discoveryUrl`, THE verifier SHALL cache kết quả OIDC_Discovery (suy ra `jwks_uri`) với TTL riêng và làm mới định kỳ; SHALL validate `issuer` trong tài liệu discovery khớp trường `issuer` cấu hình.
6. THE External_Auth_Verifier SHALL cache **issuer-config** (bản ghi `auth_external_issuers`) với TTL ngắn (vd ≤ 60s) qua `c.get('runtime').cache` (runtime abstraction — CLAUDE.md Rule #3) để PATCH/DELETE ở Req 2.6 có hiệu lực kịp thời mà không query DB mỗi request.

### Requirement 9: Just-In-Time provisioning (tùy chọn)

**User Story:** Là một admin, tôi muốn người dùng hợp lệ từ IdP được tạo tự động lần đầu đăng nhập (nếu tôi bật), để không phải provision thủ công từng người trước.

#### Acceptance Criteria

1. WHERE `jitProvisioning=false` (mặc định), WHEN một External_JWT hợp lệ trỏ tới một `externalId` chưa có bản ghi `users`, THE External_Auth_Verifier SHALL từ chối với HTTP 403 `{ errors: [{ code: 'USER_NOT_PROVISIONED' }] }` (yêu cầu pre-provision qua SCIM/admin).
2. WHERE `jitProvisioning=true`, WHEN một External_JWT hợp lệ trỏ tới `externalId` chưa tồn tại, THE External_Auth_Verifier SHALL tạo bản ghi `users` (id `nanoid`, `external_id` = externalId resolve được, email từ claim, `status='active'`) và một `userSites` membership cho `site_id` với `roleId` từ Role_Mapping/`defaultRoleId`, trong một thao tác idempotent (`onConflictDoNothing` theo `external_id`).
3. THE JIT_Provisioning SHALL match user đã tồn tại theo `external_id` trước; chỉ tạo mới khi không tìm thấy — SHALL không bao giờ tạo trùng user cho cùng `externalId`.
4. WHEN JIT tạo hoặc cập nhật membership, THE CMS SHALL ghi Audit_Log `external_user_provisioned` `{ siteId, issuer, externalId, roleId }` (KHÔNG kèm token hay claim thô).
5. WHERE một `externalId` đã có `users` nhưng `status != 'active'`, THE External_Auth_Verifier SHALL từ chối với HTTP 401 (giữ nhất quán với verify nội bộ — `auth.ts:247-252`), kể cả khi JIT bật.
6. THE JIT_Provisioning SHALL gán user vào đúng `site_id` đã resolve ở Req 5; SHALL không bao giờ tạo membership cho site khác.

### Requirement 10: Không rò rỉ thông tin nhạy cảm (logging & errors)

**User Story:** Là một kỹ sư bảo mật, tôi muốn không token hay bí mật nào lọt vào log hoặc response, để tránh rò rỉ qua nhật ký vận hành.

#### Acceptance Criteria

1. THE CMS SHALL KHÔNG bao giờ ghi raw External_JWT (toàn phần hoặc chữ ký) vào log, audit metadata, error message, hay HTTP response — chỉ ghi định danh an toàn (`iss`, `kid`, `sub` hashed nếu cần, reason code), theo đúng tinh thần `formatSafeError` (`middleware/auth.ts:7,153,277`).
2. THE error response cho mọi thất bại external-auth SHALL dùng mã chung `UNAUTHENTICATED`/`FORBIDDEN`/`TOKEN_EXPIRED` mà KHÔNG tiết lộ chi tiết khiến kẻ tấn công phân biệt "issuer không tồn tại" với "chữ ký sai" ở response (lý do chi tiết chỉ vào Audit_Log/server log).
3. THE Audit_Log cho external-auth (`external_auth_denied`) SHALL ghi `{ issuer?, reason, siteId, ip, userAgent, requestId }` theo khuôn `auditApiKeyUseDenied` (`middleware/auth.ts:49-69`) — không kèm claim PII thô ngoài email khi cần thiết.
4. THE issuer admin endpoints SHALL không bao giờ echo lại giá trị có khả năng là secret trong response hay log; validate input để loại trường lạ trước khi lưu.

### Requirement 11: Threat model — không mở rộng bề mặt tấn công khi "bypass internal auth"

**User Story:** Là một kỹ sư bảo mật, tôi muốn việc cho phép bypass auth nội bộ không tạo ra lỗ hổng leo thang quyền, để tính năng tiện lợi không đánh đổi an toàn.

#### Acceptance Criteria

1. THE External_Auth_Verifier SHALL chỉ chấp nhận token mà chữ ký được verify bởi JWKS của một issuer **được admin của chính site đó** đăng ký tường minh (`enabled=true`); một issuer mặc định/ngầm định SHALL không tồn tại.
2. THE feature SHALL không cho phép `HS256` (đối xứng) cho external — loại bỏ lớp tấn công "key confusion" (RS256→HS256) bằng cách enforce allowlist bất đối xứng (Req 3.4, 2.3).
3. THE External_Auth_Verifier SHALL từ chối token thiếu `iss`, thiếu `kid` khi cần, hoặc `aud` rỗng khi audience được cấu hình — không "best-effort accept".
4. THE feature SHALL không cấp `adminAccess` mặc định cho bất kỳ external principal nào (sửa lỗi `auth.ts:147`); leo thang lên admin chỉ qua Role_Mapping tường minh tới role có `adminAccess=true`.
5. WHEN một admin xoá hoặc disable issuer, THE token đang lưu hành của issuer đó SHALL mất hiệu lực trong vòng TTL issuer-config (Req 8.6) — không có "vé vĩnh viễn".
6. THE feature SHALL không vô hiệu hoá hay làm yếu validate `siteId` của nhánh custom JWT nội bộ hiện có (`auth.ts:231-238`); hai nhánh độc lập.
7. THE External_Auth_Verifier SHALL áp giới hạn kích thước token và độ sâu/độ lớn claim hợp lý để tránh JWKS/JWT bomb (parsing DoS).

### Requirement 12: Tương thích & cấu hình môi trường

**User Story:** Là một maintainer, tôi muốn feature hoạt động ở cả hai runtime (Cloudflare Workers + Docker/Node) và không phá cấu hình hiện có, để release an toàn.

#### Acceptance Criteria

1. THE feature SHALL hoạt động ở cả runtime Cloudflare Workers và Node.js/Docker; mọi truy cập cache JWKS/issuer-config SHALL qua runtime abstraction (`c.get('runtime').cache`) chứ không phụ thuộc binding CF cụ thể (CLAUDE.md Rule #3).
2. THE feature SHALL giữ nhánh Cloudflare Access hiện tại (`auth.ts:125-159`) hoạt động; CỐ Ý có thể (tùy chọn) mô tả CF Access như một issuer external đặc biệt trong tương lai, nhưng v1 SHALL không xoá nhánh CF Access để tránh regression (xem Open Question).
3. THE feature SHALL không yêu cầu thêm env var bắt buộc mới; cấu hình issuer sống trong DB (`auth_external_issuers`). WHERE cần một công tắc toàn cục, THE feature MAY dùng một flag tùy chọn (mặc định cho phép) nhưng SHALL không làm hỏng instance thiếu flag.
4. THE feature SHALL dùng `jose` đã có (`SignJWT`/`jwtVerify`/`createRemoteJWKSet`) — KHÔNG thêm thư viện JWT mới.
5. THE migration tạo bảng `auth_external_issuers` SHALL được viết tay (hand-written) tiếp nối chuỗi `drizzle/0031_*.sql` (tức `0032_*`) kèm sửa `drizzle/meta/_journal.json` — KHÔNG dùng `drizzle-kit generate` (theo memory "Migrations are hand-written"), và SHALL idempotent (`CREATE TABLE IF NOT EXISTS`).

### Requirement 13: Kiểm thử

**User Story:** Là một maintainer, tôi muốn feature có test đủ phủ các nhánh bảo mật, để hồi quy bị bắt sớm.

#### Acceptance Criteria

1. THE feature SHALL có unit test cho verifier với JWT ký bằng key test (RS256/ES256): chấp nhận token hợp lệ; từ chối `alg:none`, `HS256`, sai `aud`, sai `iss`, hết `exp`, `nbf` tương lai, `kid` không khớp.
2. THE feature SHALL có test multi-tenant: token cho site A bị từ chối khi request mang `X-Lumi-Site` của site B (Req 5).
3. THE feature SHALL có test role-mapping: claim không ánh xạ → 403 `NO_ROLE_MAPPING` (default-deny); claim ánh xạ tới role admin → principal có `adminAccess` qua PermissionService; KHÔNG có đường nào hard-code admin.
4. THE feature SHALL có test JIT: bật → tạo user+membership idempotent; tắt → 403 `USER_NOT_PROVISIONED`.
5. THE feature SHALL có test chuỗi verify: API key vẫn ưu tiên; token external không decode được → fallback custom JWT; token external `iss` khớp nhưng verify fail → KHÔNG fallback (fail-closed) (Req 7).
6. THE feature SHALL có integration test admin CRUD: tạo/sửa/xoá issuer, enforce `adminAccess`, từ chối `HS256` trong `algorithms`.

### Requirement 14: Setup Impact Registry

**User Story:** Là một maintainer, tôi muốn feature này được rà soát theo Setup Impact Registry, để biết nó có yêu cầu khởi tạo gì khi setup instance mới không.

#### Acceptance Criteria

1. WHEN feature external-jwt-auth hoàn thành, THE feature SHALL được rà soát theo 6 câu hỏi trong `.kiro/specs/admin-setup-wizard/setup-impact.md` và ghi một dòng vào bảng Registry (kể cả khi kết quả là `n/a`).
2. THE rà soát SHALL xác định: feature thêm bảng `auth_external_issuers` nhưng **không cần seed** (rỗng khi khởi tạo — issuer do admin đăng ký theo nhu cầu, giống `clickhouse-cdc`/`lumibase-firebase-sync`); **không** settings key bắt buộc mới; **không** bước UI wizard mới (issuer cấu hình sau setup qua admin API); **không** capability flag mới trong `/setup/capabilities`; và **không cần backfill** instance cũ (migration chỉ `CREATE TABLE IF NOT EXISTS`, instance cũ không có issuer → no-op, hành vi auth hiện có giữ nguyên).
