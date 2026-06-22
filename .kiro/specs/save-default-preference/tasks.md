# Implementation Plan

## Overview

Kế hoạch triển khai **Save-Action Default Preference** theo 4 phase. Phase A đặt nền (enum + Zod schema dùng chung + cột site + migration viết tay). Phase B xây backend (preferences PATCH endpoint cho self + nối `defaultSaveAction` vào site config). Phase C xây Studio UI (resolve fn thuần + Save_Control split-button + điều hướng sau save + hai trang settings). Phase D hoàn thiện docs + Setup Impact + DoD. Mỗi task gắn ref requirement và section design. Mỗi task = một commit riêng (theo quy ước commit của repo).

## Tasks

### Phase A — Enum, schema, cột site & migration

- [ ] 1. Enum & Zod schema dùng chung
  - [ ] 1.1 Thêm `SAVE_ACTIONS`/`SaveAction`/`SaveActionSchema`/`DEFAULT_SAVE_ACTION` (=`'return'`) vào `packages/shared/src/schemas` và export từ `packages/shared/src/schemas/index.ts` (Req 2.1, 3.3; design §3)
  - [ ] 1.2 Tạo `packages/shared/src/schemas/user-preferences.ts`: `UserPreferencesSchema` (`.passthrough()`, `saveAction` optional) + `PreferencesUpdateSchema` (`saveAction` nullable optional, `.passthrough()`); export type (Req 2.1, 2.4, 2.5, 8.4; design §6)
  - [ ] 1.3 Sửa `packages/shared/src/schemas/site-config.ts`: thêm `defaultSaveAction: SaveActionSchema` cạnh `defaultAppearance` (dòng 169); `SiteConfigUpdateSchema.partial()` tự kế thừa (Req 3.3; design §6)
  - [ ] 1.4 Unit test schema: enum hợp lệ pass; giá trị sai reject; key lạ không reject (passthrough); `saveAction` vắng vẫn parse (Req 2.2, 2.4, 2.5; design §6, §9)

- [ ] 2. Cột site + migration viết tay
  - [ ] 2.1 Thêm cột `defaultSaveAction: text('default_save_action').default('return').notNull()` vào `sites` pgTable cạnh `defaultAppearance` (`packages/database/src/schema/core.ts:38`); cập nhật doc-comment `users.preferences` thành `{ language, theme, timezone, defaultPresets, saveAction }` (`core.ts:61`) (Req 3.1, 3.2; design §2.1, §2.2)
  - [ ] 2.2 Viết tay migration `packages/database/drizzle/0032_save_default_preference.sql` (`ALTER TABLE "sites" ADD COLUMN IF NOT EXISTS "default_save_action" text NOT NULL DEFAULT 'return';`) + thêm entry vào `packages/database/drizzle/meta/_journal.json` (KHÔNG `drizzle-kit generate` — quy ước 0012+) (Req 3.2, 9.3; design §2.3)

### Phase B — Backend endpoints

- [ ] 3. Preferences PATCH (self-service)
  - [ ] 3.1 Thêm `PATCH /preferences` vào `meRouter` trong `apps/cms/src/routes/auth.ts` (cùng họ `GET /me` tại dòng 621): scope theo `c.get('auth').userId`, parse `PreferencesUpdateSchema`, merge nông vào `users.preferences` (bảo toàn key cũ; `saveAction: null` → xoá key), trả `{ data: merged }` không kèm PII (Req 1.1-1.5, 2.2, 7.2; design §5.1)
  - [ ] 3.2 (Tùy quyết định open-question §3) mở rộng `GET /api/v1/me` response trả `preferences` (hoặc thêm `GET /me/preferences`) để Studio đọc `User_Save_Action` (Req 8.1; design §5.1, §7.3, open question 3)
  - [ ] 3.3 Integration test preferences: round-trip ghi→đọc đúng; merge bảo toàn `language`/`theme`; enum sai 422; user A không ghi được pref user B (Req 1.2, 1.3, 2.2, 8.1, 8.2; design §5.1, §9)

- [ ] 4. Site default qua site config
  - [ ] 4.1 Đảm bảo route `GET/PATCH /api/v1/site` (`apps/cms/src/routes/site.ts`) đọc/ghi cột `default_save_action` (map trường `defaultSaveAction`); validate enum + scope `siteId` qua `SiteConfigSchema` đã sửa (Req 3.4; design §5.2)
  - [ ] 4.2 Integration test site config: PATCH `defaultSaveAction` persist + đọc lại; enum sai reject; scope theo siteId (Req 3.4; design §5.2)

### Phase C — Studio UI

- [ ] 5. Resolve fn thuần
  - [ ] 5.1 Tạo `resolveSaveAction(userPref, siteDefault): SaveAction` + guard `isSaveAction` (user valid → site valid → `'return'`) ở `apps/studio/src` (Req 4.1-4.5; design §7.3, §8)
  - [ ] 5.2 Unit test `resolveSaveAction`: mọi tổ hợp của bảng precedence (§8) gồm giá trị lạ/undefined → không throw (Req 4.1-4.5; design §8)

- [ ] 6. Save_Control + điều hướng sau save
  - [ ] 6.1 Thay nút "Save changes" (`apps/studio/src/modules/content/item-detail.tsx:268-282`) bằng split-button `Save_Control`: nút chính = `Effective_Save_Action`, dropdown 3 hành động (one-off), mục "Set as default"; giữ điều kiện disable `!isDirty || saveMutation.isPending || !canUpdate` (Req 6.1-6.4; design §7.4)
  - [ ] 6.2 Mở rộng `saveMutation.onSuccess` (`item-detail.tsx:148-153`): sau invalidate, navigate theo `pendingAction ?? effective` — `return`→`/content/$collection` (mirror `item-detail.tsx:161`), `create_new`→route "new", `stay`→không navigate; `onError` giữ form không navigate (Req 5.1-5.5; design §7.4, open question 4)
  - [ ] 6.3 "Set as default" → `PATCH /api/v1/me/preferences { saveAction }`, cập nhật state cục bộ optimistic để nhãn nút chính đổi ngay (Req 6.3, 6.5; design §7.4)
  - [ ] 6.4 Component test `item-detail`: mỗi `Effective_Save_Action` điều hướng đúng sau save thành công; save fail không navigate; one-off không đổi pref đã lưu (Req 5.1-5.5, 6.2; design §7.4)

- [ ] 7. Trang Settings
  - [ ] 7.1 Settings → Site (`apps/studio/src/modules/settings/site-page.tsx`): thêm `<select>` `defaultSaveAction` mirror `defaultAppearance`, chú thích "Per-user preference overrides this." (Req 3.5; design §7.1)
  - [ ] 7.2 Settings → Account/Preferences: control chọn `User_Save_Action` + "Use site default" (PATCH `{ saveAction: null }`); nhãn "Use site default" hiển thị giá trị site hiện hành; toast khi lưu (Req 7.1-7.4; design §7.2)

### Phase D — Docs, Setup Impact, DoD

- [ ] 8. Docs & registry & DoD
  - [ ] 8.1 Cập nhật `docs/en/api/hono-api-spec.md`: thêm `PATCH /api/v1/me/preferences` (body, response, error codes) + ghi chú trường `defaultSaveAction` của `/api/v1/site` (DoD §4)
  - [ ] 8.2 Cập nhật `docs/en/data-model.md` (và doc liên quan): mô tả key `users.preferences.saveAction` + cột `sites.default_save_action` + thứ tự kế thừa Effective_Save_Action (DoD §4; design §8)
  - [ ] 8.3 **Setup Impact**: thêm một dòng `n/a` vào `.kiro/specs/admin-setup-wizard/setup-impact.md` (feature `save-default-preference`, phiên bản hiện hành) với ngày rà soát + lý do: dùng `users.preferences` JSONB sẵn có; cột `sites.default_save_action` `NOT NULL DEFAULT 'return'` → migration `0032` additive idempotent, không seed/flag/wizard/capability/backfill (Req 9; design §11; DoD §2)
  - [ ] 8.4 `pnpm typecheck` **recursive** (turbo run typecheck — không chỉ `-F` một package) + `pnpm test` pass; tick các task done trong file này (DoD §1, §3; MEMORY typecheck-recursive-vs-per-package)
