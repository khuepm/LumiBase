# Design Document — Save-Action Default Preference

## Overview

Thiết kế cho **Save-Action Default Preference**: cho phép cấu hình hành vi điều hướng sau khi lưu nội dung (`stay` / `return` / `create_new`) như một **per-user preference** với fallback cấp **site**. Feature tái sử dụng toàn bộ hạ tầng đã có — `users.preferences` JSONB, mô hình kế thừa theme/appearance kiểu Directus, và content edit form của Studio — nên bề mặt thay đổi rất nhỏ.

Nguyên tắc thiết kế: **không phát minh cơ chế mới, mirror pattern sẵn có**.
- Per-user storage = một key trong `users.preferences` (đã tồn tại, `packages/database/src/schema/core.ts:62`), giống cách `theme`/`language`/`timezone` đã sống ở đó.
- Site default = một cột trên `sites`, mirror **chính xác** `defaultAppearance` (`core.ts:38`) và đường đi của nó qua `SiteConfigSchema` (`packages/shared/src/schemas/site-config.ts:169`).
- Inheritance = mô hình đã mã hoá trong comment `site-config.ts:5-11`: *site giữ global default; per-user trong `users.preferences` đè lúc render*.
- Navigation = mở rộng `saveMutation.onSuccess` của `apps/studio/src/modules/content/item-detail.tsx` (hiện chỉ invalidate query, `item-detail.tsx:148-152`), tái dùng `useNavigate` đã import (`item-detail.tsx:2,26`).

## Architecture

```
┌──────────────────────── Studio (React) ───────────────────────────┐
│  Settings → Account/Preferences        Settings → Site             │
│    [ Save action: ▾ stay/return/new ]    [ Default save action ▾ ]  │
│    └─ PATCH /api/v1/me/preferences       └─ PATCH /api/v1/site       │
│                                                                     │
│  Content edit form (item-detail.tsx)                                │
│    Save_Control (split-button)                                      │
│      ├─ main btn → Effective_Save_Action                            │
│      ├─ dropdown → one-off action (không đổi pref)                  │
│      └─ "Set as default" → PATCH /api/v1/me/preferences             │
│                                                                     │
│  resolveSaveAction(userPref, siteDefault) → Effective_Save_Action   │
│    user (valid enum) ?? siteDefault ?? 'return'  (pure fn)          │
│         │ on save success → navigate by Effective_Save_Action        │
└─────────┼───────────────────────────────────────────────────────────┘
          │ HTTP
          ▼
┌──────────────────────── CMS (Hono) ───────────────────────────────┐
│  /api/v1/me/preferences  (PATCH)  → merge users.preferences         │
│       Zod PreferencesUpdateSchema (saveAction enum, partial)        │
│       scope: c.get('auth').userId                                   │
│  /api/v1/site            (GET/PATCH) → sites.default_save_action     │
│       SiteConfigSchema (+ defaultSaveAction)  scope: siteId         │
└─────────┬───────────────────────────────────────────────────────────┘
          ▼
   Postgres (Drizzle)
     users.preferences  JSONB  { language, theme, timezone,
                                 defaultPresets, saveAction }   ← key mới
     sites.default_save_action  text  DEFAULT 'return' NOT NULL ← cột mới
```

Bề mặt mới gồm: (1) một enum dùng chung ở `packages/shared`, (2) một endpoint preferences PATCH cho self (`/api/v1/me/preferences`, cùng họ `meRouter` với `GET /api/v1/me` tại `apps/cms/src/routes/auth.ts:621`), (3) một cột `sites` + trường `SiteConfigSchema`, (4) hàm `resolveSaveAction` + `Save_Control` + điều hướng trong Studio.

## 1. Tham chiếu requirements ↔ thiết kế (Traceability)

| Requirement | Component thiết kế |
|---|---|
| Req 1 (lưu pref cá nhân) | §4 `users.preferences.saveAction`, §5.1 `PATCH /me/preferences` |
| Req 2 (validate enum) | §3 `SaveAction` enum, §6 `PreferencesUpdateSchema`, §5.1 validate phase |
| Req 3 (site default) | §4 cột `sites.default_save_action`, §6 `SiteConfigSchema`, §5.2 site endpoint, §7 Studio Settings → Site |
| Req 4 (resolve/inheritance) | §8 `resolveSaveAction` pure fn (precedence table) |
| Req 5 (navigation sau save) | §9 save mutation onSuccess navigation |
| Req 6 (Save_Control split-button) | §9 `Save_Control` |
| Req 7 (settings cá nhân) | §7 Studio account/preferences page |
| Req 8 (round-trip/forward compat) | §5.1 merge semantics, §6 strip/optional, §8 fallback |
| Req 9 (setup impact) | §11 Setup Impact |

## 2. Mô hình dữ liệu

### 2.1 Per-user — KHÔNG thêm cột (dùng JSONB sẵn có)

`users.preferences` JSONB đã tồn tại tại `packages/database/src/schema/core.ts:61-62`:

```ts
/** `{ language, theme, timezone, defaultPresets }` */
preferences: jsonb('preferences').default({}).notNull(),
```

Feature thêm một key `saveAction` vào object này. **Không migration cho `users`**. Cập nhật doc-comment thành `{ language, theme, timezone, defaultPresets, saveAction }` (Req 8.2 — merge bảo toàn key cũ). Vì cột mặc định `{}`, mọi user (mới lẫn cũ) đọc ra "chưa cấu hình" và rơi về site default (Req 8.3).

### 2.2 Site default — một cột mirror `defaultAppearance`

Thêm cột vào bảng `sites` (`core.ts:25-47`), đặt cạnh `defaultAppearance` (`core.ts:38`) và `defaultLanguage` (`core.ts:36`):

```ts
// sites pgTable, mirror defaultAppearance:
/** Default save action for new editors: 'stay' | 'return' | 'create_new'.
 *  Per-user override lives in users.preferences.saveAction. */
defaultSaveAction: text('default_save_action').default('return').notNull(),
```

`DEFAULT 'return' NOT NULL` → instance cũ tự có giá trị tương đương hành vi hiện tại; migration additive, không backfill (Req 3.2, 9.3).

### 2.3 Migration (viết tay, 0032+)

Theo quy ước repo (migration 0012+ viết tay, KHÔNG `drizzle-kit generate`; xem MEMORY "Migrations are hand-written"; migration mới nhất là `0031`):

```sql
-- 0032_save_default_preference.sql
ALTER TABLE "sites"
  ADD COLUMN IF NOT EXISTS "default_save_action" text NOT NULL DEFAULT 'return';
```

`IF NOT EXISTS` + `DEFAULT` → idempotent, an toàn chạy lại. Thêm thủ công entry vào `packages/database/drizzle/meta/_journal.json` (mirror các migration trước trong `packages/database/drizzle/`).

## 3. Enum `SaveAction` (shared)

Một nguồn duy nhất, đặt ở `packages/shared` (đúng quy ước `site-config.ts`, dùng chung CMS validate + Studio form + SDK type):

```ts
export const SAVE_ACTIONS = ['stay', 'return', 'create_new'] as const;
export type SaveAction = (typeof SAVE_ACTIONS)[number];
export const SaveActionSchema = z.enum(SAVE_ACTIONS);
export const DEFAULT_SAVE_ACTION: SaveAction = 'return';
```

`DEFAULT_SAVE_ACTION` là `Hardcoded_Fallback` được tham chiếu cả ở migration default, site column default, và `resolveSaveAction` — một hằng để tránh ba chỗ lệch nhau.

## 4. Bề mặt lưu trữ tổng hợp

| Lớp | Vị trí | Mặc định | Phạm vi |
|---|---|---|---|
| `User_Save_Action` | `users.preferences.saveAction` (JSONB key) | vắng = chưa đặt | per-user (`userId`) |
| `Site_Default_Save_Action` | `sites.default_save_action` (cột mới) | `'return'` | per-site (`siteId`) |
| `Hardcoded_Fallback` | `DEFAULT_SAVE_ACTION` (hằng shared) | `'return'` | toàn cục |

## 5. Service / endpoint flow

### 5.1 `PATCH /api/v1/me/preferences` (Req 1, 2)

Đặt trong `meRouter` (`apps/cms/src/routes/auth.ts`, cùng họ `GET /me` tại dòng 621), authenticated bằng middleware auth sẵn có (không cần `requireSiteAdmin` — đây là self-service).

1. `const userId = c.get('auth').userId` (scope theo chính user — Req 1.3).
2. Parse body bằng `PreferencesUpdateSchema` (Zod, `.partial()`, strip key lạ). Enum sai → 422 `VALIDATION_ERROR` (Req 2.2) trước khi chạm DB.
3. Đọc `users.preferences` hiện tại, **merge nông** (`{ ...current, ...patch }`) để bảo toàn `language`/`theme`/`timezone`/`defaultPresets` (Req 1.2, 8.2). Nếu patch đặt `saveAction: null` → xoá key (Req 7.2 "Use site default").
4. `UPDATE users SET preferences = <merged>, updated_at = now() WHERE id = userId`.
5. Trả `{ data: merged }` — chỉ object preferences, không trả `passwordHash`/`tfa`/PII (Req 1.5).

> Quyết định: dùng PATCH partial-merge thay vì PUT để client (Save_Control "Set as default") chỉ cần gửi `{ saveAction }` mà không phải biết các key khác. Mirror `SiteConfigUpdateSchema.partial()` (`site-config.ts:176`).

### 5.2 `GET/PATCH /api/v1/site` (Req 3)

Endpoint site config đã tồn tại (Setup Impact #12, route `apps/cms/src/routes/site.ts`). Chỉ cần `SiteConfigSchema` thêm `defaultSaveAction` (§6) — route đọc/ghi cột `sites.default_save_action` không cần logic mới ngoài việc map trường. PATCH dùng `SiteConfigUpdateSchema.partial()` sẵn có, scope theo `siteId` (Req 3.4).

## 6. Zod schemas (`packages/shared`)

**Preferences schema** (mới, `packages/shared/src/schemas/user-preferences.ts`):

```ts
export const UserPreferencesSchema = z.object({
  language: z.string().optional(),
  theme: z.string().optional(),
  timezone: z.string().optional(),
  defaultPresets: z.unknown().optional(),
  saveAction: SaveActionSchema.optional(),          // Req 2.1, 2.4
}).passthrough();                                    // Req 2.5, 8.4 — forward compat

// PATCH: cho phép saveAction: null để "Use site default" (Req 7.2)
export const PreferencesUpdateSchema = z.object({
  saveAction: SaveActionSchema.nullable().optional(),
}).passthrough();
```

`.passthrough()` (thay vì `.strict()`) thoả Req 2.5/8.4: key tương lai (`language` mới, v.v.) không bị reject. `saveAction` `.optional()` thoả Req 2.4 (bản ghi cũ thiếu key vẫn parse được).

**Site schema** (sửa `packages/shared/src/schemas/site-config.ts`, thêm cạnh `defaultAppearance` ở dòng 169):

```ts
defaultAppearance: z.enum(['auto', 'light', 'dark']),
defaultSaveAction: SaveActionSchema,                 // Req 3.3 — mirror dòng trên
```

`SiteConfigUpdateSchema = SiteConfigSchema.partial()` (dòng 176) tự động cho phép PATCH chỉ `defaultSaveAction`.

## 7. Studio UI

### 7.1 Settings → Site (Req 3.5)

`apps/studio/src/modules/settings/site-page.tsx` đã render form site-config (có chú thích "language preferences override these defaults" ở dòng ~164). Thêm một `<select>` `defaultSaveAction` mirror control `defaultAppearance`, với chú thích "Per-user preference overrides this." Submit qua PATCH /site sẵn có.

### 7.2 Settings → Account/Preferences (Req 7)

Một control chọn `User_Save_Action` ba lựa chọn + mục "Use site default". Nhãn "Use site default" hiển thị giá trị site hiện hành (Req 7.3), ví dụ `Use site default (Return to list)`. Chọn "Use site default" → PATCH `{ saveAction: null }` (xoá override). Lưu phản hồi toast/inline (Req 7.4).

### 7.3 `resolveSaveAction` — pure fn (Req 4)

Đặt ở `apps/studio/src/modules/content/` (hoặc `apps/studio/src/lib/`):

```ts
export function resolveSaveAction(
  userPref: unknown,
  siteDefault: unknown,
): SaveAction {
  if (isSaveAction(userPref)) return userPref;          // Req 4.1, 4.2
  if (isSaveAction(siteDefault)) return siteDefault;     // Req 4.1
  return DEFAULT_SAVE_ACTION;                            // 'return' — Req 4.3
}
const isSaveAction = (v: unknown): v is SaveAction =>
  typeof v === 'string' && (SAVE_ACTIONS as readonly string[]).includes(v);
```

Thuần, không DB/không render → unit test mọi tổ hợp (Req 4.4); giá trị lạ coi như "chưa cấu hình", không throw (Req 4.5, 5.x). `userPref` đọc từ `/api/v1/me` (mở rộng response `auth.ts:621` để trả `preferences.saveAction`, hoặc đọc qua preferences read); `siteDefault` đọc từ site config query mà Studio đã có.

### 7.4 `Save_Control` + điều hướng (Req 5, 6)

Trên `apps/studio/src/modules/content/item-detail.tsx`, thay nút "Save changes" hiện tại (`item-detail.tsx:268-282`) bằng split-button:

```
┌───────────────────────┬───┐
│  Save & return        │ ▾ │   ← nhãn = Effective_Save_Action
└───────────────────────┴───┘
                          │
        ┌─────────────────┴──────────────┐
        │ ○ Save & stay                  │  ← one-off (Req 6.2)
        │ ● Save & return                │
        │ ○ Save & create new            │
        │ ─────────────────────────────  │
        │ ☆ Set current as default       │  ← Req 6.3 → PATCH /me/preferences
        └────────────────────────────────┘
```

- Nút chính `onClick` → `saveMutation.mutate({ action: effective })`.
- `saveMutation.onSuccess` (mở rộng `item-detail.tsx:148-153`):

```ts
onSuccess: () => {
  queryClient.invalidateQueries(/* item/list/revisions — giữ nguyên */);
  const action = pendingAction ?? effectiveSaveAction;   // one-off ?? default
  if (action === 'return')      navigate({ to: '/content/$collection', params: { collection } });
  else if (action === 'create_new') navigate({ to: <route "new" của collection> });
  // 'stay' → không navigate, chỉ reset dirty (Req 5.1)
},
```

- `return` mirror đúng điều hướng `deleteMutation.onSuccess` (`item-detail.tsx:161`).
- Navigation chỉ trong `onSuccess`; `onError` giữ form + hiển thị lỗi (`item-detail.tsx:286-288`), không navigate (Req 5.4, 5.5).
- Disable theo `!isDirty || saveMutation.isPending || !canUpdate` (giữ nguyên `item-detail.tsx:271`, Req 6.4).
- "Set as default" → `PATCH /me/preferences { saveAction }`, cập nhật state cục bộ optimistic (Req 6.5).

> Quyết định: hành động one-off lưu vào một biến `pendingAction` set ngay trước `mutate`, reset sau `onSuccess`. Không ghi DB cho one-off (Req 6.2).

## 8. Precedence / fallback (Req 4) — bảng quyết định

| `User_Save_Action` | `Site_Default_Save_Action` | → `Effective_Save_Action` |
|---|---|---|
| `stay`/`return`/`create_new` (valid) | bất kỳ | = User_Save_Action |
| vắng / không hợp lệ | `stay`/`return`/`create_new` (valid) | = Site_Default_Save_Action |
| vắng / không hợp lệ | vắng / không hợp lệ | `'return'` (Hardcoded_Fallback) |

Vì `sites.default_save_action` là `NOT NULL DEFAULT 'return'`, dòng cuối thực tế chỉ xảy ra khi dữ liệu site bị hỏng/giá trị lạ — `resolveSaveAction` vẫn an toàn (Req 4.5).

## 9. Round-trip & forward compat (Req 8)

- Round-trip property (Req 8.1): `PATCH /me/preferences { saveAction: X }` → đọc lại = `X`, với `X ∈ SAVE_ACTIONS`. Integration test với DB thật.
- Merge bảo toàn (Req 8.2): seed `preferences = { language: 'vi', theme: 'dark' }`, PATCH `{ saveAction: 'stay' }`, assert `{ language: 'vi', theme: 'dark', saveAction: 'stay' }`.
- Bản ghi cũ thiếu key (Req 8.3): `preferences = {}` → `resolveSaveAction(undefined, siteDefault)` = site default; không backfill.
- Key lạ (Req 8.4): PATCH với một key chưa khai báo → `.passthrough()` giữ/không reject.

## 10. Tại sao không thêm bảng/cột cho user

Cân nhắc một bảng `user_preferences` riêng hoặc cột `users.default_save_action` chuyên dụng — **bác bỏ**: `users.preferences` JSONB đã được thiết kế đúng cho loại dữ liệu này (`core.ts:61` liệt kê `theme`/`language`/`timezone`/`defaultPresets` cùng họ), và mô hình inheritance Directus (`site-config.ts:5-11`) đã chuẩn hoá "per-user trong `users.preferences`". Thêm cột riêng sẽ phá vỡ tính nhất quán và tốn migration cho bảng `users` lớn. Chỉ `sites` cần một cột (mirror `defaultAppearance`) vì site config dùng cột typed, không dùng JSONB cho các default này.

## 11. Setup Impact (Req 9)

Rà soát 6 câu hỏi:
1. Seed? **Không** — `users.preferences` mặc định `{}`; `sites.default_save_action` có DB default `'return'`.
2. Settings key bắt buộc? **Không** — `defaultSaveAction` là cột typed có default, không phải settings row.
3. Policy/grant DB? **Không** — preferences self-service gated bằng auth middleware; site config gated `requireSiteAdmin` sẵn có.
4. Bước UI wizard? **Không** — cấu hình sau setup (Settings → Account / Settings → Site).
5. Capability flag? **Không**.
6. Backfill? **Không** — cột site `NOT NULL DEFAULT 'return'` (instance cũ tự có giá trị tương đương hành vi hiện tại); user rows thiếu key rơi về site default qua `resolveSaveAction`. Migration `0032_save_default_preference` additive `ADD COLUMN IF NOT EXISTS` (viết tay theo quy ước 0012+).

→ Dự kiến **n/a** (chỉ thêm một cột additive idempotent + một JSONB key, không seed/flag/wizard/capability/backfill). Ghi `n/a` vào Registry với ngày rà soát.

## Open questions

1. **Default value nên là `'return'` hay `'stay'`?** **CHỐT (2026-06-22, theo maintainer): `'stay'`.** `Hardcoded_Fallback = 'stay'` + `sites.default_save_action` DEFAULT `'stay'`. Lý do: hành vi *code* hiện tại của `item-detail.tsx` là "stay" (save không navigate); chọn `'stay'` giữ **zero behavior change** cho mọi instance đang chạy + thân thiện với writer (đúng tinh thần complaint gốc). User/admin tự đổi sang `'return'`/`'create_new'` nếu muốn parity Directus. (Khác với khuyến nghị `'return'` ban đầu của spec — maintainer ưu tiên không đổi cảm nhận hiện tại.)
2. **Per-collection override?** Một số team muốn `create_new` cho collection "Products" nhưng `return` cho "Pages". v1 **bỏ** (chỉ user + site). v2 có thể thêm `users.preferences.saveActionByCollection: Record<collectionName, SaveAction>` — vẫn là JSONB, không migration. — *Chốt: ngoài phạm vi v1.*
3. **Phơi `preferences.saveAction` qua `GET /api/v1/me` hay endpoint preferences riêng để đọc?** `GET /me` (`auth.ts:621`) hiện KHÔNG trả `preferences`. Hai lựa chọn: (a) mở rộng `/me` response thêm `preferences`, (b) thêm `GET /api/v1/me/preferences`. Ưu tiên (a) để Studio đọc một lần cùng các trường user khác. — *Quyết định lúc implement; nếu (a) làm payload `/me` phình, dùng (b).*
4. **Route "new" của collection** (`create_new`) có tồn tại sẵn trong TanStack Router của Studio không? Cần xác nhận tên route tạo item khi implement (`item-detail.tsx` dùng `/content/$collection` cho list). Nếu chưa có route "new" chuyên dụng, `create_new` điều hướng tới form rỗng cùng pattern. — *Xác nhận lúc implement.*
