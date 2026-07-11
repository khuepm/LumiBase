# Design — Collection Create Modes

> Status: **Proposal / Roadmap**. Tham chiếu code hiện tại đã verify; thành phần mới đánh dấu `[Proposal]`.

## 1. Bối cảnh & vị trí trong kiến trúc

Luồng tạo collection hôm nay:

```
/data-model/new  →  wizard.tsx (5 steps)  →  POST /api/v1/collections
                                          →  PUT /api/v1/collections/:name/fields/:field (mỗi field)
```

Spec này chèn một bước trước wizard và mở rộng service:

```
/data-model/new
  └─ [Proposal] ModeSelector  ──┬─ view         → wizard.tsx (+ DefaultFieldCatalogue panel)
                                ├─ db-view       → DbObjectPicker  → registerDbCollection()
                                └─ flexible-view → DbObjectPicker  → registerDbView(readOnly)
```

Không thêm runtime mới, không phá vỡ wizard hiện có. Tất cả mode cuối cùng đều ghi vào hai bảng có sẵn: `collections` và `fields` ([`packages/database/src/schema/cms.ts`](packages/database/src/schema/cms.ts)).

## 2. Mapping vào schema hiện có (không cần migration cho View_Mode)

| Khái niệm spec | Cột/bảng có sẵn | Ghi chú |
|---|---|---|
| Mode đăng ký DB | `collections.storage_mode` (`jsonb`/`materialized`/`physical`/`external`) | `db-view` → `physical`/`external`; `flexible-view` → `external` + cờ read-only |
| Read-only flag (Flexible_View) | **[Proposal] cột mới** `collections.read_only` boolean | Cần migration thủ công (memory: migrations 0012+ viết tay + sửa journal) |
| Nguồn đối tượng DB (table/view tên) | **[Proposal] cột mới** `collections.source_object` text | Tên bảng/view vật lý khi storage_mode != jsonb |
| Default field config | payload `PUT .../fields/:field` | Không cần cột mới; chỉ là preset payload ở UI |
| Uncatalogued field | sự *vắng mặt* của record `fields` cho một cột DB | Logic ở [`db-view-introspection`](../db-view-introspection/design.md) |

> **Quyết định:** View_Mode KHÔNG cần migration. DB_View_Mode/Flexible_View_Mode cần 2 cột mới (`read_only`, `source_object`) — viết tay theo [[migrations-are-hand-written]].

## 3. Frontend (`apps/studio/src/modules/data-model/`)

### 3.1 `[Proposal] mode-selector.tsx`
- Render 3 card (lucide icon). Default highlight = `view`.
- Disable card kèm tooltip nếu storage prerequisite không thoả (Req 1.5).
- On Continue → `navigate({ to: '/data-model/new', search: { mode } })`. Router đã hỗ trợ search param và Admin_Base ([`apps/studio/src/router.tsx`](apps/studio/src/router.tsx)).

### 3.2 `wizard.tsx` (mở rộng, không viết lại)
- Đọc `search.mode`. Nếu `mode !== 'view'` → render nhánh DB picker thay vì các step schema.
- Thêm `DefaultFieldCatalogue` panel trong step "System fields".

### 3.3 `[Proposal] default-field-catalogue.tsx`
Preset thuần ở client, mỗi entry sinh ra một `FieldInput`:

```ts
// [Proposal] hình minh hoạ, không phải code cuối
const DEFAULT_FIELDS = {
  sort:       { name: 'sort', type: 'integer', interface: 'input', hidden: true },
  created_at: { name: 'created_at', type: 'timestamp', interface: 'datetime', readonly: true },
  updated_at: { name: 'updated_at', type: 'timestamp', interface: 'datetime', readonly: true },
  created_by: { name: 'created_by', type: 'relation', interface: 'relation-m2o', readonly: true /* → users */ },
  updated_by: { name: 'updated_by', type: 'relation', interface: 'relation-m2o', readonly: true /* → users */ },
  name:       { name: 'name', type: 'string', interface: 'input' },
  localize:   { name: 'localized_content', type: 'text-localized' /* GAP — chưa tồn tại, xem Req 5 */ },
} as const
```
- `id` không nằm trong catalogue tick — nó là primary key, chọn kiểu ở step Storage (`collections.primary_key_type`).
- Tick `created_by`/`updated_by` → ngoài `fields`, gọi relations endpoint để tạo quan hệ m2o tới `users`.

### 3.4 `[Proposal] db-object-picker.tsx` (db-view & flexible-view)
- Gọi endpoint introspection (định nghĩa ở [`db-view-introspection`](../db-view-introspection/design.md)) liệt kê bảng/view chưa đăng ký.
- Cảnh báo nếu bảng nguồn thiếu cột `site_id` (Req 3.4).

### 3.5 `[Proposal] LocalizeDropdown` component dùng chung
- Vị trí đề xuất: `apps/studio/src/components/localize-dropdown.tsx`.
- Props: `value`, `onChange`, `multiple?`.
- Nội bộ: nhóm "Tenant" (từ Tenant_Locales) trên cùng + nhóm "All locales" (BCP-47) dưới; badge "default" cho `sites.default_language`.
- Nguồn Tenant_Locales: hook `useTenantLocales()` — đọc từ API của [`tenant-localization-config`](../tenant-localization-config/design.md); fallback tạm `[default_language, 'en', 'vi']`.
- Refactor [`apps/studio/src/modules/translations/index.tsx`](apps/studio/src/modules/translations/index.tsx) dùng component này (thay dropdown hard-code).

## 4. Backend (`apps/cms/src/services/schema-service.ts`)

### 4.1 View_Mode
Không đổi `createCollection`. Field default chỉ là nhiều lời gọi `createField` từ client.

### 4.2 `[Proposal] registerDbCollection(input)` — DB_View_Mode
1. Verify đối tượng DB tồn tại + chưa đăng ký (introspection).
2. Insert `collections` với `storage_mode='physical'|'external'`, `source_object=<table>`, `site_id`.
3. KHÔNG sinh DDL.
4. KHÔNG tự tạo record `fields` — để Uncatalogued (chấm than) cho tới khi người dùng configure.

### 4.3 `[Proposal] registerDbView(input)` — Flexible_View_Mode
- Như 4.2 + `read_only=true`.
- Mọi mutation item phải bị chặn — thêm guard trong item service đọc `collections.read_only` (mở rộng [`apps/cms/src/routes/collections.ts`](apps/cms/src/routes/collections.ts) + item route).

### 4.4 Multi-tenant guard
- Mọi mode set `site_id`. DB-backed mode: nếu bảng nguồn không có `site_id`, đánh dấu collection là không-RLS-được và yêu cầu xác nhận (Req 3.4) — ghi cảnh báo vào `activity`.

## 5. Response format
Tuân `{ data, meta? }` / `{ errors: [...] }` (rule #5). Mode selector là UI thuần, không có endpoint riêng. Đăng ký DB tái dùng `POST /api/v1/collections` với body mở rộng (`mode`, `sourceObject`, `readOnly`).

## 6. Edge cases & rủi ro
- **Integer PK trong jsonb:** đã có guard `assertPrimaryKeyStorageCompatible()`; mode selector phải tôn trọng (Req 1.5).
- **Bảng DB không có site_id:** rò rỉ tenant nếu bỏ qua → bắt buộc xác nhận, không auto.
- **Localize field chưa có nền tảng:** không được ship preset `localize` ghi vào `items.data` khi chưa có ADR (Req 5.4) → ẩn/đánh dấu "coming soon" cho tới khi quyết định.
- **Renumber migration song song:** 2 cột mới có thể đụng số migration với branch khác → renumber khi merge ([[parallel-feature-branches-migration-numbering]]).

## 7. Cross-spec dependencies
- [`db-view-introspection`](../db-view-introspection/design.md) — provider introspection + bootstrap field.
- [`tenant-localization-config`](../tenant-localization-config/design.md) — nguồn Tenant_Locales.
- ADR field-level localization — [`docs/en/architecture/decisions/`](docs/en/architecture/decisions/).
