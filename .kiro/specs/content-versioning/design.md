# Design Document — Content Versioning

## Overview

Thêm lớp **named versions** (nhánh draft song song) trên nền `revisions` hiện có. Revisions = lịch sử append-only (giữ nguyên). Versions = workspace song song có tên, snapshot data tách main, promote = áp lên main qua `ItemService.update` để revision + cache + RLS chạy đúng.

Nguyên tắc thiết kế: **tái dùng tối đa**. Compare dùng cùng shape `Change` của `RevisionsDiff`; promote đi qua `ItemService.update` (không viết path mutate riêng → tự động có revision/provenance/cache-invalidation); permission tái dùng check của items route.

## Architecture

### Bảng mới: `contentVersions`

```ts
// packages/database/src/schema/cms.ts
export const contentVersions = pgTable('content_versions', {
  id: text('id').primaryKey(),                     // nanoid()
  siteId: text('site_id').notNull().references(() => sites.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull(),
  collectionId: text('collection_id').notNull().references(() => collections.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),                       // slug ổn định
  name: text('name').notNull(),                     // nhãn người đọc
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  hash: text('hash').notNull(),                     // sha của main lúc snapshot → phát hiện divergence
  createdBy: text('created_by').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (t) => ({
  uniq: uniqueIndex('content_versions_key_unique').on(t.siteId, t.collectionId, t.itemId, t.key),
  itemIdx: index('content_versions_item_idx').on(t.siteId, t.itemId),
}));
```

Migration: viết tay theo [[migrations-are-hand-written]] — file SQL mới + thêm dòng vào journal. ID dùng `nanoid()` (domain table, ADR-001).

### Service: `content-version-service.ts`

```ts
// apps/cms/src/services/content-version-service.ts
export interface ContentVersionRow { id, siteId, itemId, collectionId, key, name, data, hash, createdBy, createdAt, updatedAt }

export class ContentVersionService {
  constructor(private db: Db, private siteId: string) {}
  list(collection, itemId): Promise<(ContentVersionRow & { mainChanged: boolean })[]>
  create(collection, itemId, key, name, createdBy): Promise<ContentVersionRow>   // snapshot main
  get(collection, itemId, key): Promise<ContentVersionRow | null>
  update(collection, itemId, key, patch: { data?, name? }): Promise<ContentVersionRow>
  remove(collection, itemId, key): Promise<void>
  compare(collection, itemId, key): Promise<{ main, version, changes: Change[] }>
  // promote KHÔNG nằm ở đây — route gọi ItemService.update rồi remove() (xem dưới)
}

// hash helper: ổn định, không phụ thuộc thứ tự key
function hashData(data): string  // dùng crypto-service hiện có hoặc sha256(JSON.stringify(sortKeys(data)))

// Change: import shape chung — đặt ở packages/shared để FE/BE/SDK cùng dùng
export interface Change { key: string; state: 'added'|'removed'|'changed'|'unchanged'; before: unknown; after: unknown }
export function diffFields(before, after): Change[]   // logic shallow diff giống revisions-diff.tsx
```

`mainChanged` = `version.hash !== hashData(currentMain.data)`.

### Routes: gắn vào `items.ts` (sub-router versions)

Đặt cùng file `apps/cms/src/routes/items.ts` (nơi đã có revisions/revert) để chia sẻ middleware permission + `buildService`. Hoặc tách `apps/cms/src/routes/versions.ts` mount dưới cùng prefix — chọn gắn vào items.ts cho gần revisions.

```
GET    /items/:collection/:id/versions
POST   /items/:collection/:id/versions              { key, name }
GET    /items/:collection/:id/versions/:key
PATCH  /items/:collection/:id/versions/:key         { data?, name? }
DELETE /items/:collection/:id/versions/:key
GET    /items/:collection/:id/versions/:key/compare
POST   /items/:collection/:id/versions/:key/promote
```

**Promote handler (then chốt phối hợp):**
```ts
.post('/:collection/:id/versions/:key/promote', async (c) => {
  const vsvc = buildVersionService(c);
  const v = await vsvc.get(collection, id, key);
  if (!v) return c.json({ errors: [{ message: 'Version not found' }] }, 404);
  const mainHash = hashData((await buildService(c).getOne(collection, id)).data);
  const mainDiverged = v.hash !== mainHash;
  // đi qua ItemService.update → revision (authorType human) + cache invalidation + RLS + HITL nếu cần
  const updated = await buildService(c).update(collection, id, v.data);
  await vsvc.remove(collection, id, key);
  return c.json({ data: updated, meta: { mainDiverged } });
})
```

Permission: reuse cùng guard với `PATCH /items/:collection/:id` (update permission). Versions là biến thể của mutate item.

### SDK mở rộng (backward-compatible)

```ts
// packages/sdk/src/types.ts
export interface ContentVersion {
  id: string; siteId: string; itemId: string; collectionId: string;
  key: string; name: string; data: Record<string, unknown>;
  createdBy: string | null; createdAt: string; updatedAt: string;
  mainChanged?: boolean;
}
export interface VersionCompare { main: Record<string, unknown>; version: Record<string, unknown>; changes: Change[] }
```
Client methods thêm vào items namespace: `listVersions/createVersion/getVersion/updateVersion/deleteVersion/compareVersion/promoteVersion`. Không đổi method cũ → backward-compatible.

## Component tree (Studio)

```
modules/content/
├─ item-detail.tsx (sửa) — thêm <VersionSwitcher/> ở header; khi activeVersion != null:
│     editor đọc/ghi version.data; banner "Đang chỉnh version"
├─ version-switcher.tsx (mới) — dropdown Main + versions; New/Delete; gọi SDK
├─ version-banner.tsx (mới) — banner khi đang ở version + cảnh báo mainChanged
├─ version-compare-panel.tsx (mới) — tái dùng <RevisionsDiff changes={compare.changes}/>
└─ revisions-diff.tsx (giữ) — đổi import Change sang shape chung nếu cần

state: activeVersionKey: string | null (null = Main). useQuery versions list (queryKey ['versions', collection, id]).
```

### Luồng promote (sequence)

```
Editor(version) ── Promote ──> dialog (cảnh báo nếu mainChanged)
   └─ confirm → SDK.promoteVersion → POST .../promote
        BE: ItemService.update(main ← version.data) → +revision, invalidate cache; remove version
        ← { data: item, meta: { mainDiverged } }
   FE: invalidate ['item'], ['revisions'], ['versions']; activeVersionKey = null; toast
```

## Error handling

- Tạo version `key` trùng → 409 `{ errors: [{ message }] }`; UI hiện lỗi inline ở dialog.
- Promote khi version không tồn tại (đã bị xoá ở tab khác) → 404; UI refetch list.
- `mainDiverged` không phải lỗi — last-write-wins; chỉ cảnh báo.

## Testing strategy

- Service unit: `create` snapshot đúng main; `compare` ra `Change[]` đúng; `mainChanged` true khi main đổi; `diffFields` parity với `revisions-diff.tsx` (cùng input → cùng output).
- Route: promote gọi `ItemService.update` (spy) → có revision; version bị xoá sau promote; permission denial 403; `meta.mainDiverged`.
- FE component: VersionSwitcher chuyển Main↔version; banner hiển thị khi ở version; compare panel render `RevisionsDiff`; promote invalidate đúng 3 query.
- Multi-tenant: version site A không lộ sang site B (filter `siteId`).
