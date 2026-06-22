# Design Document — Presets Inheritance

## Overview

Schema presets + roles.parentId đã đủ; thiếu **resolution logic** và UI. Spec này thêm `preset-service.ts` (precedence + Role_Chain), endpoint `effective`/`bookmarks`, quyền tạo theo scope, và UI bookmark switcher + auto-save view. Trục: **resolution ở backend** (FE không gộp scope), **quyền theo scope** (user tự quản, role/global cần admin), **không đổi schema** (tận dụng cột sẵn có).

## Architecture

### Service: `apps/cms/src/services/preset-service.ts`

```ts
export type PresetScope = 'user'|'role'|'global';
export interface EffectivePreset { layout; layoutQuery; layoutOptions; search; filter; refreshInterval; sourceScope: PresetScope|null; sourcePresetId: string|null }

export class PresetService {
  constructor(private db, private siteId, private userId, private roleId) {}

  async roleChain(): Promise<string[]> {            // role → parent → ... (cycle guard, filter siteId)
  }
  async effective(collection): Promise<EffectivePreset> {
    // 1) user-default (userId, bookmark null) → nếu có, dùng
    // 2) role-default theo roleChain (gần trước) → dùng cái đầu tiên tìm thấy
    // 3) global-default (userId null, roleId null, bookmark null)
    // 4) null
  }
  async bookmarks(collection): Promise<(PresetRow & { scope: PresetScope })[]> {
    // user bookmarks + role bookmarks (roleChain) + global bookmarks
  }
  // CRUD đi qua route với check quyền theo scope (dưới)
}
```

**Precedence resolution (lõi):**
```
effective(collection):
  chain = roleChain()                       // [roleNear, ...roleFar]
  user = findPreset(userId, null, collection, bookmark=null)
  if user return {...user, sourceScope:'user'}
  for r in chain:
    p = findPreset(null, r, collection, bookmark=null)
    if p return {...p, sourceScope:'role'}
  g = findPreset(null, null, collection, bookmark=null)
  if g return {...g, sourceScope:'global'}
  return emptyEffective()
```

### Routes (`apps/cms/src/routes/presets.ts` — thêm)

```
(giữ) GET /api/v1/presets, GET/:id, POST, PATCH/:id, DELETE/:id
+ GET /api/v1/presets/effective?collection=    → EffectivePreset (user hiện tại)
+ GET /api/v1/presets/bookmarks?collection=     → bookmark khả kiến + scope badge
```

**Quyền theo scope (áp ở POST/PATCH/DELETE):**
```
scopeOf(preset) = userId? 'user' : roleId? 'role' : 'global'
- scope 'user' & userId === currentUser  → cho phép
- scope 'user' & userId !== currentUser  → 403 (trừ admin)
- scope 'role' | 'global'                → cần admin (hoặc quyền quản lý preset)
```

### SDK

```ts
getEffectivePreset(collection): Promise<EffectivePreset>
listBookmarks(collection): Promise<Bookmark[]>
saveUserView(collection, state): Promise<void>     // upsert user-default (bookmark null), debounce ở FE
createBookmark(collection, name, scope, state)
updateBookmark(id, patch); deleteBookmark(id)
```

## Component tree (Studio `modules/content/`)

```
modules/content/
├─ collection-view.tsx (sửa)
│   ├─ on mount: getEffectivePreset(collection) → khởi tạo view state
│   ├─ on view-state change: debounce saveUserView (scope user)
│   └─ <BookmarkSwitcher/>
├─ bookmark-switcher.tsx (mới) — dropdown bookmark khả kiến (scope badge) + Default view + Save as bookmark + Reset to default
├─ save-bookmark-dialog.tsx (mới) — tên + scope (user/role/global theo quyền)
modules/settings/ (hoặc role detail)
└─ role-presets.tsx (mới) — admin quản preset role/global: list + sửa/xoá
```

## Sequence — mở collection + auto-save

```
collection-view mount → SDK.getEffectivePreset('posts')
   BE: roleChain → user/role/global default → EffectivePreset (sourceScope)
   FE: áp layout/filter/sort làm state khởi tạo
user đổi filter → debounce 800ms → SDK.saveUserView('posts', state)
   BE: upsert preset (userId=current, roleId=null, bookmark=null)
"Reset to default" → DELETE user-default → getEffectivePreset lại (rơi về role/global)
```

## Sequence — bookmark scope role (admin)

```
admin "Save as bookmark" scope=role → SDK.createBookmark('posts','Editorial','role',state)
   BE: check admin → insert preset (roleId=adminChosenRole, bookmark='Editorial')
mọi user thuộc role đó → listBookmarks('posts') thấy 'Editorial' (scope badge role, read-only với họ)
```

## Quyết định mở

1. **Multi-role:** nếu user có nhiều role, dùng primary role để dựng Role_Chain (nhất quán PermissionService primary-role). Ghi rõ khi implement; nếu cần gộp nhiều role → định nghĩa thứ tự rõ ràng.
2. **Reset semantics:** "Reset to default" chỉ xoá user-default; bookmark user giữ nguyên.
3. **Debounce save:** 800ms; chỉ save khi state thực sự khác effective (tránh ghi thừa).

## Error handling

- Tạo/sửa preset role/global không quyền → 403.
- Sửa bookmark của user khác (non-admin) → 403.
- Role chain cycle (parentId vòng) → cycle guard cắt, log cảnh báo.
- collection không tồn tại → effective trả empty (không lỗi cứng) hoặc 404 tuỳ — chọn empty để FE robust.

## Testing strategy

- `roleChain`: dựng đúng chuỗi parent; cycle guard.
- `effective`: precedence user > role-gần > role-xa > global; empty khi không có.
- `bookmarks`: trả đúng user + role-chain + global; scope badge đúng.
- Quyền: user không sửa được preset role/global; không sửa preset user khác.
- FE: getEffectivePreset áp state; saveUserView debounce + chỉ khi khác; BookmarkSwitcher scope badge; Reset xoá user-default.
- Multi-tenant: preset site A không lộ site B.
