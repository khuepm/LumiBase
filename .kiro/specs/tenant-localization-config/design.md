# Design — Tenant Localization & Identity Config

> Status: **Proposal / Roadmap**. Tham chiếu code hiện tại đã verify; thành phần mới đánh dấu `[Proposal]`.

## 1. Quyết định lưu trữ Tenant_Locales

Hai phương án (Req 1.1). **Khuyến nghị: (b) bảng `settings`** vì:
- Bảng `settings` đã tồn tại với `(site_id, key)` unique, `scope` (`site`/`module`), value JSONB ([`packages/database/src/schema/platform.ts:123`](packages/database/src/schema/platform.ts)).
- Trang Translations *đã* đọc `settings.get('locales')` — chỉ cần làm cho nó có thật thay vì fallback hard-code.
- **Không cần migration** → tránh xung đột số migration ([[parallel-feature-branches-migration-numbering]]).

```
settings row: { site_id, key:'locales', scope:'site',
  value: [ { tag:'vi', label:'Tiếng Việt', enabled:true },
           { tag:'en', label:'English',   enabled:true } ] }
```

`Default_Locale` vẫn ở `sites.default_language` (single source, Req 1.2). Invariant: `default_language ∈ locales[].tag`.

> Phương án (a) cột `sites.locales` chỉ chọn nếu cần query/index theo locale ở DB — hiện chưa cần.

## 2. API (mở rộng endpoint có sẵn)

Không tạo endpoint mới. Mở rộng `GET/PATCH /api/v1/site` ([`apps/cms/src/routes/site.ts`](apps/cms/src/routes/site.ts)):

- `GET /api/v1/site` → thêm `data.locales` (đọc từ `settings`).
- `PATCH /api/v1/site` → chấp nhận `locales` + `adminPath`; validate qua `SiteConfigUpdateSchema` mở rộng trong [`packages/shared/src/schemas/`](packages/shared/src/schemas/).

Validate (Req 2.2):
```ts
// [Proposal] mở rộng SiteConfigUpdateSchema
locales: z.array(z.object({
  tag: z.string().refine(isBcp47),
  label: z.string(),
  enabled: z.boolean().default(true),
})).optional()
// refine: default_language phải nằm trong locales[].tag
```

## 3. Frontend

### 3.1 `site-page.tsx` — mục "Languages" mới
- List locale có kéo-thả sắp thứ tự (thứ tự = ưu tiên hiển thị, Req 1.3).
- Nút thêm dùng `LocalizeDropdown` chung.
- Radio/badge chọn Default_Locale → ghi `default_language`.
- Cảnh báo khi gỡ locale đang có translations (Req 1.4) — query `translations` theo `language`.

### 3.2 `site-page.tsx` — Admin_Path
- Thêm input Admin_Path vào nhóm Identity (Req 3.3).
- Đổi giá trị → modal cảnh báo "URL admin sẽ đổi" + xác nhận (Req 3.4).

### 3.3 `useTenantLocales()` hook (shared)
- Đọc `GET /api/v1/site → data.locales`.
- Là nguồn cho `LocalizeDropdown` ([`collection-create-modes`](../collection-create-modes/design.md) §3.5).
- Refactor [`apps/studio/src/modules/translations/index.tsx`](apps/studio/src/modules/translations/index.tsx) bỏ fallback hard-code `['en','vi']`, dùng hook này.

## 4. Setup wizard
- Khởi tạo `settings.locales = [{ tag: default_language, ... }]` khi setup xong (Req 4.2).
- Admin_Path từ `/setup/path` ghi sẵn; Req 3.3 cho sửa sau.
- Ghi Setup Impact Registry (Req 4.1).

## 5. Edge cases
- **Default không nằm trong locales:** validate chặn (invariant §1).
- **Gỡ locale có nội dung:** cảnh báo, không cascade-delete translations.
- **Admin_Path đổi giữa phiên:** session admin hiện tại có thể mất route → cảnh báo mạnh, cân nhắc yêu cầu re-login.
- **BCP-47 không chuẩn:** validate refine; cho phép subtag vùng (`en-US`) như `sites.default_language` đã minh hoạ.

## 6. Cross-spec
- Cung cấp Tenant_Locales cho [`collection-create-modes`](../collection-create-modes/design.md) Req 4 & 5.
- Dùng `settings` table có sẵn — không migration.
