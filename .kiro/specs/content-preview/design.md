# Design Document — Content Preview (B102)

## 1. Tổng quan

Preview **tái dùng hạ tầng share link** thay vì dựng hệ token mới. Share đã có sẵn:
- token hash, plaintext chỉ trả một lần;
- hạn dùng, `maxUses`, thu hồi;
- đánh giá quyền theo role giao với quyền người tạo, có mask field;
- audit.

Preview chỉ khác share ở **nguồn quyền đọc**:

| | Share (hiện có) | Preview (mới) |
|---|---|---|
| Ai đọc | Người ngoài có link | Website của chính site, phía server |
| Quyền đọc | role share ∩ người tạo | **chỉ người tạo**, đánh giá lại ở mỗi lần đọc |
| Role share | bắt buộc, không `appAccess`/`adminAccess` | không dùng (`role_id` NULL) |
| Thấy draft | chỉ khi role share đọc được | có, nếu người tạo đọc được |
| Hạn dùng | tuỳ người tạo | ≤ `preview.ttlSeconds` (mặc định 900 s, trần 3600) |

**Quyết định đã cân nhắc: không tạo role "preview".** Một role không có Studio access mà đọc được draft là role cấp quyền mới. Ai tạo được share với role đó sẽ lộ được draft của **mọi** collection role đó đọc được. Đánh giá theo người tạo thì token không bao giờ vượt quyền của người bấm Preview.

## 2. Data model

Migration viết tay `0019_share_purpose.sql`. Lấy số kế tiếp so với **mọi** branch đang mở, không chỉ `main` (xem memory "Parallel feature-branch migration numbering").

```sql
ALTER TABLE lumibase_shares ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'share';
ALTER TABLE lumibase_shares ALTER COLUMN role_id DROP NOT NULL;
ALTER TABLE lumibase_shares DROP CONSTRAINT IF EXISTS lumibase_shares_purpose_chk;
ALTER TABLE lumibase_shares ADD CONSTRAINT lumibase_shares_purpose_chk
  CHECK (purpose IN ('share', 'preview')
         AND (purpose = 'preview' OR role_id IS NOT NULL)
         AND (purpose = 'share' OR created_by IS NOT NULL));
```

- Mọi share hiện có nhận `purpose = 'share'`, nên hành vi không đổi (Req 6.1).
- Nhánh `'share'` vẫn bắt buộc `role_id` ở mức DB, nên nới `NOT NULL` không mở đường tạo share không có role.
- Preview bắt buộc `created_by`. `created_by` hiện là `ON DELETE SET NULL`: xoá user làm hàng vi phạm CHECK. Vì vậy migration đổi FK của hàng preview sang xoá theo, bằng trigger hoặc job dọn. Chốt ở task 1.2, kèm test.
- Drizzle: `packages/database/src/schema/access.ts`, thêm `purpose: text('purpose').notNull().default('share')` và bỏ `.notNull()` ở `roleId`.

`collections.meta.previewUrl`: không cần migration, vì `meta` là JSON sẵn có.

## 3. API

### 3.1 `POST /api/v1/items/:collection/:id/preview` (content plane, dưới `withAuth`)

```
→ 201 { data: { token, expiresAt, url } }
```

1. `auth.userId` bắt buộc; `apiKeyId` hoặc anonymous thì 403 `FORBIDDEN`. Cùng điều kiện với `shareAdminRouter.post('/')`.
2. `itemServiceForRequest(c)` đọc item với quyền người gọi (DoD §2c). Không thấy item thì 404.
3. `ShareService.createPreview({ collection, itemId, createdBy, ttl })`: sinh token, lưu hash, `purpose='preview'`, `role_id=NULL`, `validUntil = now + ttl`, `maxUses = 20`.
4. Nếu collection có `meta.previewUrl` thì dựng `url` phía server (§4). Không có thì trả `url: null`.
5. Audit `preview.created` với `{ collection, itemId, expiresAt }`, không kèm token.

### 3.2 `GET /api/v1/preview/:token` (public)

Mount cạnh `sharePublicRouter` (`app.use('/api/v1/preview/*', withDb())`). Không đi qua `withAuth`.

1. Tra theo hash **và** `purpose = 'preview'`. Token share thường tra ở đây thì 404 (Req 2.5); ngược lại, `ShareService.read` thêm `purpose = 'share'`.
2. `assertActiveShare` như share. Mọi lỗi (không có, hết hạn, thu hồi, vượt `maxUses`, người tạo mất quyền) trả **một** body 404 byte-identical, theo mẫu `deliver.ts` "404 không thành oracle" (Req 3.2).
3. Quyền: `PermissionService` với `ctx.userId = share.createdBy`, `roleId: null`. Dùng `canAccess(collection,'read')` rồi `whereFor(...)` để lấy item, cuối cùng `maskItem`, đúng như nhánh "creator" hiện có của `read()`.
4. `Cache-Control: no-store`, `X-Robots-Tag: noindex`. Không ghi app cache, edge cache hay search.
5. Tăng `usedCount`, audit `preview.read`.
6. Rate limit: dùng lại limiter của route public. Task 3.3 xác minh limiter có áp cho mount này không, rồi mới khẳng định.

### 3.3 Validate `meta.previewUrl`

Ở `collectionsRouter.patch('/:name')`, chạy khi có `meta.previewUrl`:
- `new URL(template.replace(/\{[a-z]+\}/g, 'x'))`; protocol phải là `http:` hoặc `https:`.
- Placeholder chỉ được thuộc `{id,slug,collection,locale,token}`.

Vi phạm thì 400 `VALIDATION`.

## 4. Dựng URL

`buildPreviewUrl(template, { id, slug, collection, locale, token })` đặt ở `packages/contracts`, để Studio và CMS dùng chung:
- mỗi giá trị đi qua `encodeURIComponent`;
- placeholder thiếu giá trị (ví dụ item không có `slug`) thì thay bằng chuỗi rỗng;
- không bao giờ nội suy HTML.

## 5. Studio

- `item-detail.tsx`: nút **Preview** (lucide `Eye`) cạnh Share, chỉ hiện khi `collection.meta.previewUrl` có giá trị và `perms.canRead`.
- Gating giống `EditorialActions`: nếu `isDirty` thì disable, title "Save your changes first." (Req 4.2).
- Khi bấm: gọi §3.1, rồi `window.open(url, '_blank', 'noopener')`. Lỗi hiện inline. Mở tab **sau** khi có URL, để không lộ tab trống. Nếu trình duyệt chặn popup, hiện link để bấm.
- Data model: ô `Preview URL` trong cài đặt collection, kèm danh sách placeholder.
- SDK: `client.items(c).preview(id)` trong `packages/sdk`.
- Shell (DoD §2d): gọi qua `getApiClient()`. `window.open` trong Tauri cần mở bằng trình duyệt hệ thống qua plugin `opener`; kiểm tra ở task 6.3.

## 6. Starter Next.js

```
app/api/preview/route.ts        GET ?token&slug → fetch CMS /api/v1/preview/:token (server)
                                  → 404: trả 401 "Preview link expired"
                                  → ok : draftMode().enable(); cookie httpOnly `lb_preview` = token; redirect /posts/:slug
app/api/exit-preview/route.ts   draftMode().disable(); xoá cookie; redirect /
app/posts/[slug]/page.tsx       draftMode().isEnabled && cookie → đọc qua /preview/:token
                                  ngược lại → publishable key (published only)
```

- Token chỉ nằm trong cookie `httpOnly; SameSite=Lax; Secure` (production). Không đưa vào props của client component, nên không vào HTML hay bundle (Req 5.2). `cms:verify` sẽ kiểm chuỗi token không xuất hiện trong `.next/static`, theo cách kiểm admin token trong nghiệm thu RC.2.
- `cms:bootstrap`: `PATCH /collections/posts` đặt `meta.previewUrl = "${LUMIBASE_PUBLIC_ORIGIN}/api/preview?token={token}&slug={slug}"`. Chỉ đặt khi chưa có, vì người dùng có thể đã sửa.
- `cms:verify`, thêm hai check. Token tạo bằng admin token, và admin token vẫn chỉ ở phía server:
  1. `POST /items/posts/:draftId/preview` → `GET /preview/:token` thấy `status: 'draft'`.
  2. Publishable key đọc cùng id → 404, như check hiện có.

## 7. Bảo mật (mapping)

| Rủi ro | Biện pháp |
|---|---|
| Token vượt quyền người tạo | Đánh giá lại quyền người tạo ở mỗi lần đọc (§3.2.3); không có role share |
| Token bị lộ qua link | TTL ≤ 15 phút mặc định, `maxUses`, thu hồi như share; `noindex`; `no-store` |
| Oracle phân biệt lý do hỏng | Một body 404 duy nhất |
| Token share dùng làm preview (và ngược lại) | Tra theo `purpose` ở cả hai router |
| Cross-tenant | Item lấy theo `share.siteId`; `scopeSite` ở mọi query |
| Token vào bundle client | Cookie `httpOnly`; check trong `cms:verify` |
| URL template độc hại (`javascript:`) | §3.3 chỉ nhận `http(s)`; `encodeURIComponent` giá trị |
| Người tạo bị xoá | CHECK + dọn hàng preview (§2) |

## 8. Setup impact (dự kiến; ghi Registry khi merge)

1. **Seed**: starter đặt `meta.previewUrl`; CMS không seed gì.
2. **Settings**: key mới `preview.ttlSeconds`, tuỳ chọn.
3. **Policy/grant**: không có.
4. **Wizard**: không.
5. **Capability**: không.
6. **Migration**: `0019_share_purpose`. Không backfill, vì default `'share'` giữ nguyên hàng cũ.

## 9. Câu hỏi mở

1. TTL mặc định: 15 phút đủ cho một vòng duyệt? Hay cần một nút "Gia hạn" trong trang preview?
2. Có cần preview theo **revision** cụ thể (ghim `revisionId` vào token) để người duyệt xem đúng bản đã gửi duyệt, thay vì bản mới nhất? Đề xuất: làm sau. Luồng duyệt hiện đã chặn chỉnh sửa khi item `in_review`; task 2.4 cần xác minh điều này.
3. Có hiện nút Preview cho item đã `published` không (xem bản đang sửa của một bài đang chạy)? Đề xuất: có, dùng cùng cơ chế.
