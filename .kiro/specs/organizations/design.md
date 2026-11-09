# Design — Organizations (organization plane)

> Status: **Proposal / Roadmap**. Thực thi [ADR-013](../../../docs/en/architecture/decisions/adr-013-organization-plane.md). Tham chiếu code hiện tại đã verify; thành phần mới đánh dấu `[Proposal]`.

## 0. Nguyên tắc dẫn đường

1. **Phân loại theo phạm vi, không xếp hạng theo sức mạnh.** `lbk_` và `lbo_` là hai *loại* credential; không có đường nào để một `lbk_` "đủ mạnh" gọi được organization plane.
2. **Không đổi gì cho người dùng một site.** Backfill Personal_Org + Studio ẩn UI khi chỉ có một org ⇒ bản self-host một tenant không thấy khác biệt.
3. **Dùng lại trước khi thêm.** Provisioning site dùng lại code setup wizard; key dùng lại `api-key-token.ts`; HITL dùng lại `ai_approvals`; audit dùng lại `auditSecurityGuardDenied`.
4. **"Control plane" giữ nghĩa cũ.** `CONTROL_PLANE_PATHS`, `controlPlaneAdmin`, control-plane skill = quản trị *site*. Tầng mới = organization plane, guard riêng, mã lỗi riêng.

## 1. Schema `[Proposal]`

`packages/database/src/schema/core.ts` (cạnh `sites`, `users`, `userSites`):

```ts
export const organizations = pgTable('lumibase_organizations', {
  id: id(),                                   // nanoid (ADR-001)
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** { billing?: {...}, contentOs?: { mcp?: { allowOrganizationTools?: boolean } } } */
  settings: jsonb('settings').default({}).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organizationMembers = pgTable(
  'lumibase_organization_members',
  {
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** owner | admin | billing | member — enum đóng, KHÔNG phải roles.id */
    role: text('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.organizationId] }),
    orgIdx: index('org_members_org_idx').on(t.organizationId),
    roleCheck: check('org_members_role_check',
      sql`${t.role} in ('owner','admin','billing','member')`),
  }),
);

// sites: thêm
organizationId: text('organization_id')
  .references(() => organizations.id, { onDelete: 'restrict' }), // NOT NULL sau backfill
```

`packages/database/src/schema/access.ts` (`apiKeys`):

```ts
scope: text('scope').default('site').notNull(),            // 'site' | 'organization'
siteId: text('site_id').references(() => sites.id, { onDelete: 'cascade' }),   // bỏ .notNull()
organizationId: text('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
// CHECK api_keys_scope_target:
//   (scope='site' AND site_id IS NOT NULL AND organization_id IS NULL)
//   OR (scope='organization' AND organization_id IS NOT NULL AND site_id IS NULL)
```

### Migration (viết tay, [[migrations-are-hand-written]])

Một file `00NN_organizations.sql`, các bước theo thứ tự trong **một** transaction:

1. `CREATE TABLE lumibase_organizations`, `lumibase_organization_members`.
2. `ALTER TABLE lumibase_sites ADD COLUMN organization_id text REFERENCES …`.
3. Backfill:
   ```sql
   INSERT INTO lumibase_organizations (id, slug, name)
   SELECT <nanoid-in-sql hoặc md5 rút gọn>, 'default',
          COALESCE((SELECT display_title FROM lumibase_sites WHERE id='__default__'),
                   (SELECT name FROM lumibase_sites WHERE id='__default__'), 'Default');
   UPDATE lumibase_sites SET organization_id = (SELECT id FROM lumibase_organizations WHERE slug='default');
   INSERT INTO lumibase_organization_members (user_id, organization_id, role)
   SELECT u.id, o.id, 'owner' FROM lumibase_users u, lumibase_organizations o
   WHERE u.is_bootstrap = true AND o.slug = 'default';
   ```
   > nanoid trong SQL: dùng `encode(gen_random_bytes(16),'hex')` cắt 21 ký tự; đủ unique cho **một** dòng backfill. Không phải nanoid chuẩn nhưng không vi phạm ADR-001 (ADR cấm serial, không bắt alphabet).
4. `ALTER TABLE lumibase_sites ALTER COLUMN organization_id SET NOT NULL`.
5. `ALTER TABLE lumibase_api_keys ADD COLUMN scope …, ADD COLUMN organization_id …, ALTER COLUMN site_id DROP NOT NULL, ADD CONSTRAINT api_keys_scope_target CHECK (…)`.

Rollback: không hỗ trợ tự động (quy ước dự án); ghi trong changelog.

Số migration: đối soát với **mọi** branch mở lúc merge ([[parallel-feature-branches-migration-numbering]]).

### RLS (`LUMIBASE_DB_RLS=enforce`)

`lumibase_organizations` / `lumibase_organization_members`: policy theo `current_setting('lumibase.organization_id')`. Request scope (spec `rls-request-scope`) thêm biến `organization_id` bên cạnh `site_id`; route `/api/v1/orgs/:orgId/*` set biến này từ path param **sau** khi guard đã xác nhận membership.

## 2. Credential: nhận diện và resolve

### 2.1 Mint `lbo_`

`apps/cms/src/services/api-key-token.ts` đã tách tạo/hash token; thêm hằng `ORGANIZATION_TOKEN_PREFIX = 'lbo_'` cạnh `PUBLISHABLE_TOKEN_PREFIX` ([`api-key-publishable.ts:29`](apps/cms/src/services/api-key-publishable.ts:29)). Hàm `classifyTokenPrefix(token): 'site' | 'publishable' | 'organization' | 'unknown'` dùng chung CMS + mcp-server (đặt ở `packages/shared`).

### 2.2 Middleware auth

[`apps/cms/src/middleware/auth.ts`](apps/cms/src/middleware/auth.ts) hiện lookup `api_keys` theo hash rồi gắn `auth.apiKey`. Thêm:

```
auth.apiKey.scope            'site' | 'organization'
auth.apiKey.organizationId   khi scope='organization'
```

**Bất biến thực thi tại đây (một chỗ duy nhất):**

| Token | Route `/api/v1/orgs/*` | Route site (`X-Lumi-Site`) |
|---|---|---|
| `lbk_` / `lbk_pub_` / `aud=frontend` | `403 ORGANIZATION_FORBIDDEN` + audit `site_scoped_credential_on_org_plane` | như hiện nay |
| `lbo_` | tiếp tục → `withOrganizationAccessGuard` | kiểm `site.organization_id === key.organizationId` → `403 SITE_NOT_IN_ORGANIZATION` nếu sai; nếu đúng → coi như `administrator` |
| `aud=studio` | tiếp tục → guard tra `organization_members` | như hiện nay, **+** fallback Req 3.3 |

### 2.3 `EffectiveCapabilityService`

[`effective-capability-service.ts`](apps/cms/src/services/effective-capability-service.ts): `PrincipalCallerClass` thêm `'organization_api_key'`. `resolveApiKey` khi `scope='organization'`:

- không có `siteId` trong context → grant rỗng cho site plane (route site sẽ 400 `TENANT_REQUIRED` từ tenant middleware trước đó, nên nhánh này chủ yếu phòng thủ);
- có `siteId` → verify site ∈ org, trả `capabilities` = bundle của role system `administrator` của site đó, `controlPlaneAdmin: true`.

> Khác với `lbk_` có policy admin (`controlPlaneAdmin: false` cố ý). Lý do: Org_Key chỉ mint được bởi org owner/admin — một principal vốn đã kế thừa site admin (Req 3.3) — nên không mở rộng bề mặt.

## 3. Guard và phân quyền `[Proposal]`

`apps/cms/src/middleware/organization-access-guard.ts`:

```ts
export const ORG_ACTIONS = [...] as const;
export type OrgAction = typeof ORG_ACTIONS[number];
// packages/shared/src/org-permissions.ts — thuần, không I/O, dùng chung Studio
export function canOrg(role: OrgRole, action: OrgAction): boolean

export const withOrganizationAccessGuard = (action: OrgAction): MiddlewareHandler<AppEnv>
// 1. token site-scoped → 403 ORGANIZATION_FORBIDDEN (đã chặn ở auth, đây là backstop)
// 2. lbo_ : key.organizationId === :orgId ? role ảo 'admin' (key không bao giờ là owner) : 404
// 3. user : tra organization_members (userId, :orgId) → role; không có → 404 (không lộ tồn tại)
// 4. !canOrg(role, action) → 403 ORGANIZATION_FORBIDDEN
// 5. c.set('organization', { id, role })
```

> **Org_Key = `admin`, không bao giờ `owner`.** Vì vậy `delete_site`, `transfer_site`, `org:delete` qua MCP bằng Org_Key luôn cần một *user* owner phê duyệt trong `ai_approvals` — HITL là bắt buộc về mặt cấu trúc, không chỉ về chính sách. Điểm này đơn giản hoá Req 5.6.

**Kế thừa xuống (Req 3.3):** [`routes/admin.ts` `hasSiteAdminAccess`](apps/cms/src/routes/admin.ts:69) và [`control-plane-access-guard.ts` `hasSiteAdminAccess`](apps/cms/src/middleware/control-plane-access-guard.ts) hiện là hai hàm khác nhau; gộp về một `resolveSiteAdminAccess(c)` trong `services/site-admin-access.ts` trả `{ allowed, via: 'role' | 'bootstrap' | 'organization' | null }`. Audit middleware đọc `via` để ghi.

## 4. API `[Proposal]`

`apps/cms/src/routes/orgs.ts`, mount `api.route('/orgs', orgsRouter)` trong [`index.ts`](apps/cms/src/index.ts) **trước** các route cần tenant. Tenant middleware ([`tenant.ts`](apps/cms/src/middleware/tenant.ts)) thêm `/api/v1/orgs` vào danh sách miễn `X-Lumi-Site` (cùng chỗ đã miễn `/api/v1/files/upload/`).

| Route | Guard | Ghi chú |
|---|---|---|
| `GET /orgs` | auth bất kỳ không phải site-scoped | `lbo_` → đúng một org; user → theo membership |
| `POST /orgs` | Instance_Operator, hoặc `LUMIBASE_ALLOW_ORG_SIGNUP=true` + `aud=studio` | tạo org + member owner = caller; `lbo_` không được tạo org |
| `GET/PATCH /orgs/:orgId` | `org:read` / `org:settings:write` | |
| `DELETE /orgs/:orgId` | `org:delete` + header `X-Confirm-Delete: <orgId>` | từ chối nếu còn site (`409 ORGANIZATION_NOT_EMPTY`) |
| `GET /orgs/:orgId/sites` | `org:read` | |
| `POST /orgs/:orgId/sites` | `org:sites:create` | §4.1 |
| `DELETE /orgs/:orgId/sites/:siteId` | `org:sites:delete` + `X-Confirm-Delete: <siteId>` | 404 nếu site ∉ org |
| `POST /orgs/:orgId/sites/:siteId/transfer` | `org:sites:transfer` ở nguồn **và** `org:sites:create` ở đích (cùng principal) | phương án "lời mời" để Phase 4 |
| `/orgs/:orgId/members[/:userId]` | `org:read` (GET) / `org:members:manage` | hạ cấp/xoá owner cuối → `409 LAST_OWNER` |
| `/orgs/:orgId/keys[/:keyId]` | `org:read` (GET, không trả token) / `org:keys:manage` | token trả về **một lần** khi tạo |

Schema Zod ở `packages/shared/src/schemas/organizations.ts`: `OrganizationCreateSchema`, `OrganizationUpdateSchema`, `OrgSiteCreateSchema { id?: siteIdSchema, name, slug? }`, `OrgMemberUpsertSchema { userId | email, role }`, `OrgKeyCreateSchema { name, description?, expiresAt? }`.

### 4.1 Provisioning site dùng chung với setup wizard

[`modules/setup/service.ts`](apps/cms/src/modules/setup/service.ts) có hàm upsert role `Administrator` (dòng ~990) và `Member` (dòng ~1034) là private của `SetupService`. Tách thành `services/site-provisioning.ts`:

```ts
export async function provisionSite(db, env, runtime, input: {
  id?: string; name: string; organizationId: string; creatorUserId?: string;
}): Promise<{ site, administratorRoleId, memberRoleId }>
// 1. insert sites (organization_id)      2. upsert administrator + member role
// 3. creatorUserId → user_sites(administrator)
// 4. reconcileOfficialExtensions(db, env, siteId).catch(noop)   (admin.ts:388 hiện tại)
// 5. forgetNegative(cache, negativeSiteKey(siteId))              (admin.ts:391 hiện tại)
```

`SetupService.initialize` gọi `provisionSite({ id: DEFAULT_SITE_ID, organizationId: personalOrg.id, … })` sau khi tạo Personal_Org (Req 7.1). `POST /orgs/:orgId/sites` gọi cùng hàm. `POST /admin/sites` **xoá**.

### 4.2 Mã lỗi mới

`ORGANIZATION_FORBIDDEN`, `ORG_SIGNUP_DISABLED`, `SITE_NOT_IN_ORGANIZATION`, `ORGANIZATION_NOT_EMPTY`, `LAST_OWNER`, `SCOPE_NOT_ALLOWED`. Thêm vào `hono-api-spec.md` (EN + VI).

## 5. MCP `[Proposal]`

### 5.1 Config

[`packages/mcp-server/src/client.ts` `configFromEnv`](packages/mcp-server/src/client.ts:181):

```ts
interface Config {
  url: string; token: string;
  tokenKind: 'site' | 'organization';   // classifyTokenPrefix(token)
  siteId?: string;                       // bắt buộc khi tokenKind='site'
  readOnly: boolean;                     // LUMIBASE_READ_ONLY
}
```

Lỗi khởi động: `lbk_` thiếu `LUMIBASE_SITE_ID` → giữ thông báo hiện tại; `lbo_` + `LUMIBASE_SITE_ID` → log "pinned to site …".

### 5.2 Đăng ký tool theo credential

[`tools/index.ts` `registerAllTools(server, client)`](packages/mcp-server/src/tools/index.ts) → `registerAllTools(server, client, config)`:

```
tokenKind='site'                 → registerSiteTools(server, client)            (không đổi; snapshot test)
tokenKind='organization' + pin   → registerSiteTools + registerOrgReadTools      (list_sites, get_organization)
tokenKind='organization' no pin  → registerOrgTools + registerSiteTools({ requireSiteArg: true })
readOnly                         → mỗi register* bỏ qua tool có annotations.destructiveHint || !readOnlyHint
```

`requireSiteArg`: mỗi tool site thêm `site: z.string()` bắt buộc vào `inputSchema`; `LumiBaseClient` nhận `siteOverride` per call để set `X-Lumi-Site`. Tool org gửi **không** `X-Lumi-Site`.

### 5.3 Tool org (`tools/organization.ts`)

| Tool | REST | Destructive | HITL |
|---|---|---|---|
| `get_organization` | `GET /orgs/:id` | | |
| `list_sites` | `GET /orgs/:id/sites` | | |
| `create_site` | `POST /orgs/:id/sites` | ✓ | `ai_approvals` |
| `delete_site` | `DELETE /orgs/:id/sites/:s` | ✓ | `ai_approvals` (và cần owner duyệt vì Org_Key = admin) |
| `transfer_site` | `POST …/transfer` | ✓ | như trên |
| `list_org_members` / `invite_org_member` | members | ✓ (invite) | `ai_approvals` |
| `create_org_key` | `POST /orgs/:id/keys` | ✓ | `ai_approvals`; token chỉ trả trong approval record, không trả về agent |

Governed harness ([`governed.ts`](packages/mcp-server/src/governed.ts)): `McpService` phía CMS thêm `organizationId` vào run context; `controlPlaneSkillFromCall` ([`routes/mcp.ts`](apps/cms/src/routes/mcp.ts)) mở rộng nhận diện skill `org:*` là control-plane skill (destructive) để backstop admin hiện có bao luôn.

Gate: `routes/mcp.ts` đọc `organizations.settings.contentOs.mcp.allowOrganizationTools` (default `false`) khi principal là Org_Key hoặc call là tool org; env `LUMIBASE_MCP_ORG_TOOLS=off` thắng setting.

## 6. Studio `[Proposal]`

- `apps/studio/src/lib/api.ts` `createApiClient(token, site)`: thêm `orgs` client không gắn `X-Lumi-Site`.
- Hook `useOrganizations()` → `GET /orgs`; shell render switcher khi `length > 1` (Req 6.1).
- Module `apps/studio/src/modules/organization/` (general, sites, members, keys); tab ẩn theo `canOrg(role, action)` từ `packages/shared`.
- "Create site" → `provisionSite` qua API → `setSite(newId)` (thay `X-Lumi-Site`), invalidate query.
- Shell (Tauri) không đổi contract: vẫn Bearer + `X-Lumi-Site`; endpoint additive.

## 7. Setup wizard

`SetupService.initialize` (service.ts ~bước 9a) thêm bước **9-pre**: tạo Personal_Org `{ slug:'default', name: displayTitle ?? name }`, member owner = bootstrap user; `provisionSite` với `organizationId`. Idempotent: `ON CONFLICT (slug) DO NOTHING` rồi select.

Setup Impact Registry: một dòng với ID tiếp theo **cao hơn mọi branch mở** ([[registry-ids-collide-across-open-prs]]): seed Personal_Org; env `LUMIBASE_ALLOW_ORG_SIGNUP` (default off), `LUMIBASE_MCP_ORG_TOOLS` (default on, chỉ dùng để ép tắt); migration + backfill; capability `organization_api_key`; không bước wizard mới (org tạo ngầm).

## 8. Test

- `apps/cms/src/__tests__/auth-middleware-matrix.test.ts`: thêm hàng `lbk_→/orgs=403`, `lbo_+site ngoài org=403`, `lbo_ không X-Lumi-Site → route site=400`.
- `apps/cms/src/routes/__tests__/orgs.test.ts`: CRUD, `LAST_OWNER`, `ORGANIZATION_NOT_EMPTY`, 404 không lộ tồn tại.
- `apps/cms/src/services/__tests__/site-provisioning.test.ts`: setup wizard và `POST /orgs/:id/sites` tạo site giống nhau (so sánh role, extension, cache purge).
- `packages/mcp-server/src/__tests__/tools.test.ts`: snapshot tool list cho 3 cấu hình + `readOnly`.
- DB integration: migration backfill trên dump có 0, 1, N site; có/không user bootstrap.

## 9. Open questions

1. `transfer_site` cần owner ở cả hai org (đơn giản, Phase 2) hay cơ chế lời mời (Phase 4)? **Đề xuất:** cả hai org trước.
2. `lbo_` có được *tạo thêm* `lbk_` cho site trong org qua `/api/v1/api-keys` (như administrator) không? **Đề xuất:** có — nhất quán với "Org_Key = administrator trên site"; đã qua guard `org:keys:manage` lúc mint `lbo_`.
3. Personal_Org có cho đổi `slug='default'` không? **Đề xuất:** có, chỉ owner; `default` không reserved sau khi đổi.
4. Studio ẩn org UI khi 1 org — nhưng trang **Organization → Keys** vẫn cần để mint `lbo_` đầu tiên. **Đề xuất:** luôn hiện mục "Organization" trong Settings cho owner/admin; chỉ ẩn *switcher*.
