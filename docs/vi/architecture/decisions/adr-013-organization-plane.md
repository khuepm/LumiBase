---
version: 1
lastUpdated: 2026-11-09T10:47:21.066Z
sourceLang: en
translatedFrom: en
sourceHash: bc1d243317196919
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-09T10:47:21.066Z
codeVerifiedHash: bc1d243317196919
codeVerifiedClaims: 26
---

# ADR-013: Organization plane (phân cấp tenant và credential phân loại theo phạm vi)

**Date:** 2026-11-09
**Status:** Proposed

<!-- verify-code-refs: planned /api/v1/orgs /api/v1/orgs/:orgId /api/v1/orgs/:orgId/sites /api/v1/orgs/:orgId/sites/:siteId /api/v1/orgs/:orgId/sites/:siteId/transfer /api/v1/orgs/:orgId/members /api/v1/orgs/:orgId/keys -->

## Context

LumiBase đa tenant theo mặc định: mọi bảng domain đều có `site_id`, mọi truy
vấn đều lọc theo nó, và một API key (`lbk_…`) gắn với đúng một site
(`api_keys.site_id`, `packages/database/src/schema/access.ts`). Role, policy và
membership (`user_sites`) đều theo từng site. Principal duy nhất đứng trên site
là bootstrap admin (`users.is_bootstrap`), và đó chỉ là một cờ boolean, không
phải principal có bề mặt API.

Vì vậy mô hình chỉ có **một mặt phẳng: site**. Không có gì trong schema trả lời
được câu hỏi "ai được tạo site, và site này của ai?":

- `sites` (`packages/database/src/schema/core.ts`) không có cột cha — không
  `owner_id`, không `organization_id`. Site không thuộc về ai cả.
- `POST /api/v1/admin/sites` và `DELETE /api/v1/admin/sites/:id`
  (`apps/cms/src/routes/admin.ts`) tồn tại chỉ vì test runner cần. Chúng được
  bảo vệ bởi `requireSiteAdmin` của site *đang gọi*, nên administrator của site
  A có thể tạo site tuỳ ý hoặc xoá site B. Cách ly tenant chỉ mạnh bằng route
  yếu nhất, và hai route này không có tenant nào để cách ly.
- MCP server (`packages/mcp-server`) phản ánh đúng mô hình đó: một
  `LUMIBASE_SITE_ID`, một token theo site, do đó không có tool `create_site`,
  `list_sites` hay `switch_site`. Điều này *đúng* với credential nó đang cầm —
  token site không bao giờ được vươn ra ngoài site — nhưng lại không để lại
  credential nào có thể làm việc đó.

Nguyên cớ của ADR này là một người dùng yêu cầu MCP server tạo site mới và phát
hiện nó không làm được. Lỗ hổng thật không phải thiếu tool; mà là thiếu một
tầng phía trên site.

### Thuật ngữ đã dùng sẵn

LumiBase đã dùng **"control plane"** cho *quản trị trong phạm vi site*:
`CONTROL_PLANE_PATHS` trong `apps/cms/src/middleware/control-plane-access-guard.ts`
(`/api/v1/access`, `/api/v1/admin`, `/api/v1/roles`, …), grant
`controlPlaneAdmin` trong `EffectiveCapabilityService`, và "control-plane
skills" trong route MCP. Nghĩa đó giữ nguyên. ADR này đưa vào một tầng *phía
trên* và đặt tên là **organization plane** để không chồng nghĩa. Kết quả là ba
tầng:

| Tầng | Phạm vi | Ai | Credential | Ví dụ |
|------|---------|----|------------|-------|
| **Instance plane** | một deployment | operator self-host | env của process, setup token, user `is_bootstrap` | setup lần đầu, lockout policy toàn instance, bật đăng ký org |
| **Organization plane** (mới) | một tài khoản tenant, N site | org owner / admin / billing | Studio session có org membership, hoặc **organization key `lbo_…`** | tạo/xoá/chuyển site, thành viên org, billing, mặc định cấp org |
| **Site plane** (hiện có) | một site | site roles | Studio session có dòng `user_sites`, hoặc **site key `lbk_…`** | control plane (`/admin`, `/roles`, …) + data plane (items, collections, flows) |

### Ngành đã hội tụ về đâu

Mọi nền tảng lớn giải cùng bài toán với cùng một hình dạng, chỉ khác tên:

| Nền tảng | Container | Tài nguyên | Bài học rút ra |
|----------|-----------|------------|----------------|
| AWS | Organization → OU → **Account** | IAM trong account | Tạo account là API của *Organizations*, không phải quyền IAM trong bất kỳ account nào. Service-control policy đặt trần cho cả cây. |
| GCP | Organization → Folder → **Project** | IAM trong project | `resourcemanager.projects.create` là quyền *trên cha*; IAM kế thừa xuống. Service account sống trong project (≈ `lbk_`). |
| Azure | Entra tenant → Management group → **Subscription** | ARM RBAC | Identity plane và resource plane tách rời; Global Administrator phải *elevate access* tường minh (có audit) mới đụng được tài nguyên. |
| Cloudflare | **Account** → Zone | zone roles | Tương đồng nhất (Zone ≈ Site). API token phân loại theo scope (account vs zone) và mang danh sách permission tường minh. |
| Supabase | Organization → **Project** | anon / service keys | Hai *loại* credential: Personal Access Token cho Management API (`create_project`, `list_organizations`) và key theo project cho dữ liệu. MCP server của họ chạy bằng PAT với `--read-only` và `--project-ref` để thu hẹp. |
| Kubernetes | Cluster | **Namespace** | `ClusterRole` vs `Role`; tạo namespace là verb ở phạm vi cluster. Mô hình ngữ nghĩa sạch nhất. |

Mẫu chung mà ADR này áp dụng: (1) một tầng container phía trên tài nguyên;
(2) quyền tạo tài nguyên nằm trên *cha* của nó; (3) credential **phân loại
theo phạm vi**, không xếp hạng theo sức mạnh — credential phạm vi tài nguyên
không bao giờ gọi được tầng container, dù đặc quyền trong tài nguyên của nó
lớn đến đâu; (4) operator của cả bản cài là tầng thứ ba, tách riêng.

## Decision

### 1. Thêm tầng `organizations`; mỗi site thuộc đúng một organization

```
organizations                     ← lumibase_organizations
  id (nanoid), slug (unique), name, settings jsonb, created_at, updated_at
organization_members              ← lumibase_organization_members
  (user_id, organization_id) PK, role: owner | admin | billing | member
sites.organization_id             ← MỚI, FK → organizations.id, NOT NULL sau backfill
api_keys.scope                    ← MỚI, 'site' | 'organization' (mặc định 'site')
api_keys.organization_id          ← MỚI, FK, chỉ đặt khi scope = 'organization'
api_keys.site_id                  ← trở thành nullable (null khi và chỉ khi scope = 'organization')
```

- ID theo Strict Rule #1 (`nanoid()`); tên bảng theo ADR-010.
- `organization_members.role` là enum đóng, không phải dòng trong `roles`. DSL
  `roles`/`policies` của site (ADR-008) mô hình hoá *bạn được làm gì với nội
  dung*; tầng organization có từ vựng cố định nhỏ và không cần DSL. `owner` là
  role duy nhất được xoá organization hoặc chuyển site ra ngoài; luôn phải tồn
  tại ít nhất một `owner` (cùng kiểu bất biến với `users_is_bootstrap_unique`).
- **Backfill:** mọi site hiện có được gắn vào một *personal organization* tạo
  cho bootstrap user (`slug = 'default'`, tên lấy từ site `__default__`). Đây là
  mẫu "personal team" của Vercel / personal account của GitHub: bản self-host
  một tenant không bao giờ thấy organization trừ khi tạo cái thứ hai.

### 2. Phân quyền organization plane là một kiểm tra riêng, không phải role to hơn

Một từ vựng action cố định được đối chiếu với `organization_members.role`:

| Action | owner | admin | billing | member |
|--------|:-----:|:-----:|:-------:|:------:|
| `org:read` | ✓ | ✓ | ✓ | ✓ |
| `org:sites:create` | ✓ | ✓ | | |
| `org:sites:delete`, `org:sites:transfer` | ✓ | | | |
| `org:members:manage` | ✓ | ✓ | | |
| `org:keys:manage` (organization key) | ✓ | ✓ | | |
| `org:billing:manage` | ✓ | | ✓ | |
| `org:settings:write` | ✓ | ✓ | | |
| `org:delete` | ✓ | | | |

**Kế thừa xuống site plane (mô hình GCP/Cloudflare):** `owner` hoặc `admin`
của organization được coi là `administrator` trên mọi site của organization —
`hasSiteAdminAccess` tra `organization_members` sau `user_sites`. Lý do: tránh
bị khoá ngoài (owner luôn khôi phục được site mà admin cuối cùng đã rời đi) và
khớp kỳ vọng của operator. Mọi lượt truy cập kiểu này được ghi vào `audit_log`
với `via: 'organization'` để giữ provenance. `billing` và `member` không kế
thừa gì; họ cần dòng `user_sites` như mọi người.

**Không bao giờ kế thừa lên trên.** `administrator` của site, key `lbk_` của
site, và grant `controlPlaneAdmin` cho không một quyền nào ở organization
plane. Posture `CONTROL_PLANE_FORBIDDEN` hiện có giữ nguyên cho tầng site; tầng
organization có mã `ORGANIZATION_FORBIDDEN` riêng.

### 3. Credential phân loại theo phạm vi; prefix nói lên loại

| Credential | Prefix | Mang | Gọi được |
|------------|--------|------|----------|
| Site key (hiện có) | `lbk_` | `site_id` | chỉ site plane |
| Publishable site key (hiện có) | `lbk_pub_` | `site_id` | chỉ data plane công khai |
| **Organization key (mới)** | **`lbo_`** | `organization_id` | organization plane; **cộng thêm** mọi site của organization đó như một `administrator` ở đó, thu hẹp bởi *site pin* tuỳ chọn |
| Studio session (hiện có) | JWT `aud: studio` | user | cả hai plane theo membership |

Prefix riêng giữ cho secret scanner và truy vấn audit không mơ hồ, cùng lý do
`lbk_pub_` tồn tại (`apps/cms/src/services/api-key-publishable.ts`).
Organization key được tạo và xoay vòng qua organization plane
(`/api/v1/orgs/:orgId/keys`), không bao giờ qua `/api/v1/api-keys`, nên site
admin không tạo được. `EffectiveCapabilityService` có thêm caller class thứ ba
`organization_api_key`; khi resolve kèm header `X-Lumi-Site`, nó kiểm tra site
đó thuộc organization của key rồi cấp capability `administrator` trên site đó.

### 4. Routing: organization plane không yêu cầu `X-Lumi-Site`

```
GET    /api/v1/orgs                          liệt kê organization mà principal thuộc về
POST   /api/v1/orgs                          tạo (instance plane quyết định ai được: §6)
GET    /api/v1/orgs/:orgId
PATCH  /api/v1/orgs/:orgId
DELETE /api/v1/orgs/:orgId                   chỉ owner, destructive, HITL với agent
GET    /api/v1/orgs/:orgId/sites
POST   /api/v1/orgs/:orgId/sites             thay POST /api/v1/admin/sites
DELETE /api/v1/orgs/:orgId/sites/:siteId     thay DELETE /api/v1/admin/sites/:id
POST   /api/v1/orgs/:orgId/sites/:siteId/transfer
GET|POST|PATCH|DELETE /api/v1/orgs/:orgId/members[/:userId]
GET|POST|DELETE       /api/v1/orgs/:orgId/keys[/:keyId]
```

- Tenant middleware (`apps/cms/src/middleware/tenant.ts`) miễn yêu cầu
  `X-Lumi-Site` cho `/api/v1/orgs`; RLS request scope (spec
  `rls-request-scope`) được đặt theo organization thay vì site.
- `POST /api/v1/admin/sites` và `DELETE /api/v1/admin/sites/:id` bị gỡ sau khi
  test runner chuyển sang route mới với organization key. Việc khoanh vùng tạm
  thời (giới hạn delete về site của chính người gọi, chặn create sau bootstrap
  user) là một hotfix riêng, không thuộc ADR này.
- Tạo site chạy đúng quy trình provisioning mà setup wizard chạy cho một site
  (role `administrator`/`member`, extension chính thức `lumibase-*` qua
  `reconcileOfficialExtensions`, purge negative cache), nên site tạo từ
  organization plane không khác gì site tạo lúc chạy lần đầu.

### 5. MCP: một server, bộ tool do credential quyết định

MCP server vẫn là một package duy nhất. Lúc khởi động nó xem xét
`LUMIBASE_TOKEN`:

| Token | `LUMIBASE_SITE_ID` | Tool được lộ ra |
|-------|--------------------|-----------------|
| `lbk_` | bắt buộc (như hiện nay) | bộ tool site hiện tại, không đổi |
| `lbo_` + site id | ghim key vào một site | bộ tool site hiện tại **cộng** `list_sites`, `get_organization` (tool org chỉ đọc) |
| `lbo_` không site id | — | tool organization (`list_sites`, `create_site`, `delete_site`, `transfer_site`, `list_org_members`, `invite_org_member`, `create_org_key`) **cộng** tool site nhận tham số `site` |

Quy tắc:

- `LUMIBASE_READ_ONLY=true` ẩn mọi tool ghi bất kể token (mẫu `--read-only`
  của Supabase). Khuyến nghị làm mặc định trong các đoạn cấu hình mẫu đã công
  bố.
- Mutation ở organization plane là **destructive theo định nghĩa** và đi qua
  `ai_approvals` (Strict Rule #4; ADR-003) khi do agent principal gọi, độc lập
  với quy ước `confirm=true` của tool site. Chúng bắt đầu ở autonomy **L0/L1**
  (đề xuất → người duyệt) và không đủ điều kiện lên veto-window hay autopilot
  trong ADR này.
- Cờ `contentOs.mcp` theo site vẫn gate tool site. Một setting organization
  `contentOs.mcp.allowOrganizationTools` (mặc định `false`) gate tool
  organization; operator của instance có thể ép tắt bằng
  `LUMIBASE_MCP_ORG_TOOLS=off`.
- Governed harness (`packages/mcp-server/src/governed.ts`) được mở rộng để mang
  `organizationId`, để run audit và kill switch bao phủ cả lời gọi
  organization plane.

### 6. Instance plane: ai được tạo organization

- Self-host (Docker): mặc định chỉ user `is_bootstrap` được tạo thêm
  organization; `LUMIBASE_ALLOW_ORG_SIGNUP=true` mở `POST /api/v1/orgs` cho mọi
  user có audience `studio`. Không đưa vào role instance mới; bootstrap user
  *chính là* operator của instance, như hiện nay.
- Hosted (`lumibase.dev`): cờ đó bật, và luồng đăng ký tạo personal
  organization ở lần đăng nhập đầu. Billing nằm trên organization, không bao
  giờ trên site.
- Setting toàn instance vẫn nằm trên site `__default__`
  (`apps/cms/src/modules/setup/site-constants.ts`); ADR này không dời chúng.
  Một ADR sau có thể nâng lên bảng `instance_settings`.

## Consequences

**Tích cực**

- Tạo, xoá và sở hữu site có chỗ đứng. Câu hỏi "ai được tạo site" được trả lời
  bằng dữ liệu, không phải bằng một route chỉ dành cho test.
- Key `lbk_` bị lộ — kể cả có policy admin — không bao giờ tạo hay xoá được
  site. Bán kính thiệt hại của credential phổ biến nhất không đổi sau ADR này
  và trở nên giới hạn *chứng minh được* trong site của nó.
- MCP server có thêm năng lực organization mà không người dùng token site nào
  thấy thêm một tool. Agent có năng lực này dưới HITL ngay từ ngày đầu.
- Phản ánh mô hình tư duy operator đã quen từ AWS/GCP/Cloudflare; Studio có
  thể hiển thị organization switcher như mọi sản phẩm tương đương.
- Billing, quota và mặc định cấp org (locale, mẫu branding, extension được
  phép) có chủ sở hữu tự nhiên, mở khoá bản hosted.

**Tiêu cực / đánh đổi**

- Hai bảng mới, ba cột mới, một migration backfill (viết tay theo quy ước dự
  án; phải đối soát số thứ tự khi merge).
- `api_keys.site_id` trở thành nullable. Mọi nơi đọc `api_keys` phải xử lý
  `scope = 'organization'`; `EffectiveCapabilityService` và middleware auth key
  là điểm thắt, nhưng việc rà soát là công việc thật.
- Kế thừa xuống (org owner ⇒ site administrator) mở rộng những gì org owner
  đọc được. Giảm nhẹ bằng provenance audit và bởi thực tế owner vốn đã cầm key
  có thể tự cấp quyền cho mình.
- Người dùng self-host một tenant có thêm khái niệm họ không cần. Giảm nhẹ bằng
  backfill personal organization: Studio ẩn UI organization khi chỉ tồn tại
  đúng một organization.

**Ghi chú bảo mật (Reality Filter)**

- Việc phân loại phạm vi (`lbk_` không gọi được `/api/v1/orgs`) có thể cưỡng
  chế ở một chỗ — middleware auth key — và phải được test ma trận bên cạnh
  `auth-middleware-matrix.test.ts`. Chừng nào test đó chưa có, ranh giới này là
  một tuyên bố thiết kế, không phải control đã quan sát. [Inference]
- Gỡ `/api/v1/admin/sites` đóng một lỗ hổng cross-tenant đang tồn tại độc lập
  với ADR này; hotfix tạm thời nên lên trước.

## Alternatives considered

1. **Cờ hoặc role `super_admin` trên `administrator`.** Từ chối: nó xếp hạng
   sức mạnh thay vì phân loại phạm vi, nên key bị lộ mang role đó tệ hơn chứ
   không an toàn hơn; không có chỗ ghi *site nào* người giữ sở hữu; và mọi
   vendor đã khảo sát đều rời bỏ nó ("elevate access" của Azure là lối thoát
   có audit, không phải mô hình).
2. **Package MCP thứ hai (`@lumibase/mcp-admin`).** Từ chối lúc này: nhân đôi
   bề mặt release và docs, trong khi credential đã mang đủ thông tin để chọn bộ
   tool. Xem lại nếu bộ tool organization vượt ~15 tool.
3. **Coi `__default__` là "root site" và treo các site khác dưới nó.** Từ
   chối: lẫn setting instance với một tenant, giữ `sites` vô chủ, và khiến việc
   xoá root site thành thảm hoạ.
4. **Mô hình hoá role organization bằng Policy DSL của site (ADR-008).** Từ
   chối: từ vựng organization là tám action cố định; ngữ nghĩa
   collection/field/row của DSL không áp dụng, và enum cố định dễ lý luận hơn
   trong một đợt review bảo mật.

## References

- `apps/cms/src/routes/admin.ts` — `POST/DELETE /sites` (sẽ gỡ)
- `apps/cms/src/middleware/control-plane-access-guard.ts` — "control plane"
  phạm vi site hiện có (không đổi)
- `apps/cms/src/services/effective-capability-service.ts` — caller class
- `apps/cms/src/services/api-key-publishable.ts` — tiền lệ prefix (`lbk_pub_`)
- `packages/database/src/schema/{core,access}.ts` — `sites`, `users`, `api_keys`
- `packages/mcp-server/src/{client,governed}.ts` — cấu hình token/site
- `docs/en/security/user-management.md` §7 — đánh giá exposure MCP trước đó
- ADR-003 (HITL), ADR-008 (Policy DSL), ADR-010 (prefix bảng), ADR-011 (realms)
- Spec: `.kiro/specs/organizations/`
