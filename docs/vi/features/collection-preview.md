---
version: 1
lastUpdated: 2026-07-07T12:01:03.930Z
sourceLang: vi
contentHash: da33d4283b788ba9
codeVerified: 2026-07-27T23:52:33.645Z
codeVerifiedHash: da33d4283b788ba9
codeVerifiedClaims: 20
---

# Collection Preview (iframe)

> Preview = nhúng một `<iframe>` trong màn edit record của Studio, trỏ tới URL template do collection cấu hình, nội suy bằng field của record đang edit — để tác giả xem trước trang web thật ngay trong admin. Lấy cảm hứng từ tính năng Live Preview của Directus.

**Trạng thái:** Đề xuất thiết kế (chưa implement). Không cần migration cho MVP.

## 1. Ý tưởng

Mỗi collection cấu hình **một URL template**, ví dụ:

```
https://staging.mysite.com/blog/{{slug}}
https://mysite.com/posts/{{id}}?preview=1
```

Khi user mở màn edit một record, Studio nội suy template bằng giá trị field của record (client-side, tái dùng renderer Mustache sẵn có), rồi nhúng URL kết quả vào `<iframe>` cạnh form. Đổi field → iframe reload (debounce).

Điểm mấu chốt về bảo mật: **URL template (do editor cấu hình) tách khỏi allowlist origin (do operator cấu hình qua env)**. Editor chọn *đường dẫn*; operator quyết định *origin nào được phép nhúng*. Kể cả khi tài khoản editor bị chiếm, iframe vẫn không thể trỏ ra origin lạ để lừa đảo hay rò token.

## 2. Data model

Không thêm cột/migration. Dùng `collections.meta` (jsonb "UI hints", `packages/database/src/schema/cms.ts`), thêm namespace `preview` — cùng pattern với `meta.systemFields` sẵn có (`schema-service.ts`). Dữ liệu round-trip sẵn: DB → `CompiledCollection.meta` → SDK `Collection.meta` → Studio, không cần đụng route/service/diff.

```jsonc
// collections.meta
{
  "preview": {
    "enabled": true,
    "url": "https://staging.mysite.com/blog/{{slug}}",
    "refreshField": "*",       // "*" = mọi field đổi thì reload; hoặc tên 1 field
    "width": "responsive"       // responsive | mobile | desktop
  }
}
```

Zod (đặt trong `packages/contracts/src/schemas/`, export cho CMS + Studio):

```ts
export const previewConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().max(2048).default(''),   // Mustache template
  refreshField: z.string().default('*'),
  width: z.enum(['responsive', 'mobile', 'desktop']).default('responsive'),
});
```

> Phương án thay thế (không dùng cho MVP): cột `previewUrl text('preview_url')` riêng, mirror `displayTemplate` khắp `CollectionInput` / `collectionInputSchema` / `CollectionConfigSchema` (`.strict()`) / compiled shape / `buildSchemaDiff`. Typed & discoverable hơn nhưng nhiều việc + cần migration.

## 3. Luồng render (Studio, React)

```
draft record (item-detail.tsx state)
  ─► interpolate(meta.preview.url, draft)      // Mustache client-side
  ─► validate origin ∈ PREVIEW_ALLOWED_ORIGINS // defense-in-depth
  ─► <iframe src={resolvedUrl} sandbox=... />
```

- **UI:** thêm tab `preview` vào bộ tab của `apps/studio/src/modules/content/item-detail.tsx` (hiện `'fields' | 'revisions' | 'versions' | 'raw'`). Chỉ hiện khi `meta.preview.enabled`. Nút bật/tắt đặt cạnh nút Share trên toolbar.
- Nội suy hoàn toàn client-side (không thêm API call) — tái dùng renderer đồng bộ với `content/mustache-template-editor.tsx` + `displays/mustache.tsx`.
- Debounce reload iframe khi `draft` đổi (~500ms), theo `refreshField`.
- Hiện URL đã resolve + nút "Open in new tab". Field trống → render `[fieldName]` để tác giả biết thiếu dữ liệu.
- Preview **phải** là component first-class, KHÔNG đi qua `sanitize-html` (sanitizer strip thẻ iframe).

## 4. Bảo mật iframe

Hai lớp tin cậy:

| Lớp | Ai kiểm soát | Rủi ro nếu buông |
|---|---|---|
| **URL template** (`meta.preview.url`) | editor có quyền sửa data-model | trỏ iframe tới origin lạ → phishing trong admin, rò token qua Referer, tabnabbing |
| **Origin allowlist** (env) | operator/DevOps lúc deploy | — (hàng rào cứng) |

### 4.1 Allowlist origin qua env

Thêm biến (khớp precedent `CORS_ALLOWED_ORIGINS`, `EXTENSION_BUNDLE_ORIGINS` trong `apps/cms/src/env.ts`):

```
# nhiều origin cách nhau bằng dấu phẩy
PREVIEW_ALLOWED_ORIGINS=https://staging.mysite.com,https://mysite.com
```

- Khai báo trong `Bindings` (`env.ts`), set per-env trong `apps/cms/wrangler.toml` (`[env.staging.vars]` / `[env.production.vars]`).
- Parse bằng `parseAllowedOrigins` sẵn có (`apps/cms/src/config/cors.ts`, đã có test).
- **Production guard:** validate trong `apps/cms/src/config/production.ts` — cấm `*` khi `LUMIBASE_ENV=production` (giống `CORS_ALLOWED_ORIGINS`).

**Enforcement 2 tầng:**

1. **Backend (nguồn sự thật):** khi lưu `meta.preview.url`, parse origin của template và chặn nếu không thuộc allowlist → `VALIDATION_FAILED`. Ngăn cấu hình xấu được lưu ngay từ đầu.
2. **Frontend (defense-in-depth):** Studio nhận allowlist (expose qua endpoint config công khai sẵn có, không hardcode) để (a) chỉ render iframe khi origin hợp lệ, (b) khớp với `frame-src` CSP.

### 4.2 CSP `frame-src` — **bắt buộc**

`apps/cms/src/middleware/security-headers.ts` hiện đặt `default-src 'none'` và **không có `frame-src`** → mọi iframe remote bị chặn. Phải thêm directive `frame-src` = danh sách allowlist:

```ts
'frame-src': parseAllowedOrigins(env.PREVIEW_ALLOWED_ORIGINS),
```

- Hiện `serializeContentSecurityPolicy` là const tĩnh, không đọc `c.env`. Cần thread env vào middleware (chỉ khi build directive).
- **KHÔNG** đụng `frame-ancestors 'none'` và `X-Frame-Options: DENY` — chúng bảo vệ Studio *khỏi bị* nhúng (chống clickjacking), không liên quan tới việc Studio *đi* nhúng.
- **Deploy topology:** nếu Studio serve standalone trên Cloudflare Pages (không qua CMS worker — xem `apps/studio/src/lib/api-base.ts`), CSP `frame-src` phải thêm ở phía Pages (`_headers`). Nếu CMS worker serve Studio HTML (đánh dấu `responseType: 'STUDIO_HTML'` qua `admin-path-guard.ts`), có thể áp `frame-src` riêng chỉ cho surface đó.

### 4.3 Thuộc tính iframe cứng

```html
<iframe
  src={resolvedUrl}
  sandbox="allow-scripts allow-same-origin allow-forms"
  referrerpolicy="no-referrer"
  loading="lazy"
  allow="" />
```

- `referrerpolicy="no-referrer"` → không rò URL admin (có thể chứa id/token) sang site preview.
- `sandbox` tối thiểu. `allow-scripts` + `allow-same-origin` chỉ an toàn vì preview origin luôn **khác** origin Studio (đảm bảo bởi allowlist là origin ngoài) — iframe không chọc ngược vào Studio được.
- `allow=""` tắt camera/mic/geolocation.
- **Không bao giờ** nhét access token / API key vào URL template — chỉ nội suy field của record.

## 5. UX cấu hình

Trong màn settings collection (`apps/studio/src/modules/data-model/detail.tsx`, thêm tab "Preview" cạnh `display`/`archive`/`raw`), copy pattern từ `display-tab.tsx`:

- Toggle **Enable preview**.
- Ô nhập URL **tái dùng `MustacheTemplateEditor`**: autocomplete field bằng `{{`, live preview URL với sample record.
- Origin không thuộc allowlist → cảnh báo inline dẫn thẳng cách sửa: *"Origin chưa được phép. Liên hệ operator để thêm vào `PREVIEW_ALLOWED_ORIGINS`."*
- Chọn khung Responsive / Mobile / Desktop.

## 6. Phạm vi triển khai

**Giai đoạn 1 (MVP):**

1. `packages/contracts`: `previewConfigSchema`.
2. `apps/cms`: env `PREVIEW_ALLOWED_ORIGINS` (`env.ts` + `wrangler.toml`) · validate origin khi lưu `meta.preview.url` · production guard · expose allowlist cho Studio · `frame-src` CSP trong `security-headers.ts`.
3. `apps/studio/data-model`: tab cấu hình Preview (tái dùng Mustache editor).
4. `apps/studio/content`: tab Preview trong `item-detail.tsx` + component iframe (sandbox + debounce reload).
5. Docs + Setup Impact Registry (`.kiro/specs/admin-setup-wizard/setup-impact.md`) theo Definition of Done.

**Giai đoạn 2 (tùy chọn):**

- **Draft preview token:** preview secret ngắn hạn, read-only, do CMS phát cho phiên preview (KHÔNG phải session token admin) để site FE render bản draft — giống preview mode của Directus/Next.js.
- **postMessage:** đồng bộ scroll / hot-reload không cần reload cả iframe.

## 7. So với Directus

| | Directus | LumiBase (đề xuất) |
|---|---|---|
| Nơi lưu | `collections.preview_url` (meta) | `collections.meta.preview.url` |
| Template | `{{ field }}` | Mustache `{{ field }}` (tái dùng display template) |
| Chặn origin | (không có allowlist env) | `PREVIEW_ALLOWED_ORIGINS` + `frame-src` CSP + validate lúc lưu |
| Draft | preview mode + token | Giai đoạn 2 |
