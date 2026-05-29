# Schema Type Generation (`schema.ts` export)

> Tương đương `npx directus-typescript-gen` của Directus, nhưng tích hợp gốc vào LumiBase và **multi-tenant aware** (sinh types theo `site_id`).

## 1. Mục tiêu

- Sinh file TypeScript chứa **type của toàn bộ collections + fields + relations** của một site, để client (Next.js, app khác) có thể `Items<'posts'>` autocomplete.
- Hỗ trợ 3 hình thức output:
  1. **Per-site** `lumibase-types.ts` (collection map + global `LumibaseSchema`).
  2. **Per-collection** module riêng (`collections/posts.ts`).
  3. **SDK-ready** — augment module `@lumibase/sdk` để `client.items('posts')` return chuẩn.

## 2. Output shape

```ts
// lumibase-types.ts (auto-generated, DO NOT EDIT)
import type { Brand, ID, Locale } from '@lumibase/sdk';

export interface Post {
  id: ID;
  status: 'draft' | 'review' | 'published' | 'archived';
  title: string;
  slug: string;
  body: string | null;
  cover: File | null;          // m2o → files
  author: User;                // m2o → users
  tags: Tag[];                 // m2m → tags
  translations: Record<Locale, { title: string; body: string }>;
  user_created: ID;
  user_updated: ID;
  date_created: string;        // ISO
  date_updated: string;
}

export interface Tag { id: ID; name: string; slug: string; }

export interface LumibaseCollections {
  posts: Post;
  tags: Tag;
  // ...
}

export type LumibaseSchema = LumibaseCollections;
```

Quy tắc mapping field → TS:
| Field type | TS |
|---|---|
| `string`, `text`, `hash`, `csv` | `string` |
| `integer`, `bigInteger`, `decimal` | `number` |
| `boolean` | `boolean` |
| `json` | `unknown` (hoặc generic nếu có schema) |
| `uuid` | `ID` brand |
| `date`/`datetime`/`time`/`timestamp` | `string` (ISO) |
| `geometry` | `GeoJSON.Geometry` |
| `alias` m2o | `T \| null` |
| `alias` o2m / m2m | `T[]` |
| `alias` m2a | `Array<{ collection: K; item: Collections[K] }>` |
| `select-dropdown` có choices | union literal |
| `translatable-text` | `Record<Locale, string>` |

Required → property bắt buộc; `required=false` → optional `?` hoặc `\| null` theo cấu hình.

## 3. CLI

Đặt trong `apps/cms/scripts/typegen.ts` (chạy bằng `tsx` hoặc Node).
```sh
pnpm lumibase typegen \
  --site <siteId> \
  --out ./apps/web/src/lumibase-types.ts \
  --format single|per-collection \
  --include posts,tags \
  --exclude users
```

Flags:
- `--auth <token>` (hoặc `LUMI_TOKEN` env).
- `--url <api-url>`.
- `--locale <en|vi|...>` để literal hoá translation keys.
- `--branded` (default true) → dùng `Brand<'PostId', string>` cho id field key (typed FK).

## 4. API

CLI gọi endpoint `GET /api/v1/typegen/schema?include=&exclude=` trả về **manifest** (collections + fields + relations + enums) đã apply permission của caller. Endpoint trả JSON ổn định, version hoá để tool generate không phụ thuộc raw DB.

```json
{
  "version": 1,
  "site": "site_xyz",
  "collections": [
    {
      "name": "posts",
      "primaryKey": "id",
      "fields": [
        { "name": "id", "type": "uuid", "required": true, "branded": "PostId" },
        { "name": "status", "type": "string", "enum": ["draft","review","published","archived"], "required": true },
        { "name": "cover", "kind": "m2o", "target": "files", "nullable": true }
      ]
    }
  ]
}
```

## 5. Studio integration

- Trang **Settings → Developer → Types**:
  - Hiển thị curl + lệnh CLI sẵn copy.
  - Nút "Download lumibase-types.ts" sinh file ngay tại browser (gọi endpoint).
  - Tab preview code (Monaco).
- Hook: khi schema thay đổi → bắn webhook (tuỳ chọn) để CI client repo tự regen.

## 6. SDK augment (`@lumibase/sdk`)

```ts
import type { LumibaseSchema } from './lumibase-types';
import { createLumiClient } from '@lumibase/sdk';

const client = createLumiClient<LumibaseSchema>({ url, token, siteId });
const post = await client.items('posts').readOne('abc'); // typed
```

`createLumiClient` generic mặc định `Record<string, unknown>` để vẫn dùng được khi chưa generate.

## 7. Tasks

- `[BE]` Endpoint `/typegen/schema` (Phase A).
- `[BE]` Permission gate: chỉ cho role `developer`/`admin`.
- `[SDK]` Generator core (`packages/sdk/src/typegen/`): manifest → TS AST (dùng `ts-morph` hoặc emit string).
- `[CLI]` Script `apps/cms/scripts/typegen.ts` + alias `lumibase typegen`.
- `[FE]` Trang Settings → Developer → Types.
- `[DOC]` Update với example end-to-end Next.js demo.

Phase: bắt đầu cuối Phase A (sau khi schema engine xong), hoàn thiện ở Phase B.
