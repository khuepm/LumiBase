# Schema Type Generation

LumiBase typegen biến schema của một tenant thành TypeScript types cho app dùng `@lumibase/sdk`. Typegen multi-tenant aware: manifest được fetch cho một site và có thể filter theo collection.

## 1. Mục tiêu

- Sinh TypeScript interfaces cho collections, fields, system fields và relations.
- Giữ primary key strategy, nullable/required, readonly/generated, encrypted field behavior và relation-expanded response types.
- Tương thích với `createLumiClient<LumibaseSchema>()`.

## 2. Output shape

```ts
// lumibase-types.ts (auto-generated)
import type { Brand, ID, Locale } from '@lumibase/sdk';

export interface Authors {
  readonly id: Brand<'AuthorsId', string>;
  readonly created_at: string;
  name: string;
}

export type AuthorsExpanded = Omit<Authors, "posts"> & {
  posts?: Array<Posts | PostsExpanded>;
};

export interface Posts {
  readonly id: Brand<'PostsId', string>;
  title: string;
  body?: string | null;
  secret_note?: string | '***' | null;
  author_id?: Brand<'AuthorsId', string> | null;
}

export type PostsExpanded = Omit<Posts, "author_id"> & {
  author_id?: Authors | AuthorsExpanded | null;
};

export interface LumibaseCollections {
  authors: Authors;
  posts: Posts;
}

export type LumibaseSchema = LumibaseCollections;
```

Base interfaces biểu diễn stored item values. `CollectionExpanded` types biểu diễn read responses khi relation fields được expand thành related objects.

## 3. Mapping rules

| Manifest input | TypeScript sinh ra |
|---|---|
| `primaryKeyType: "nanoid" | "uuid" | "string"` | `Brand<'CollectionId', string>` khi branded, nếu không là `ID`/`string`. |
| `primaryKeyType: "integer" | "bigInteger"` | `number`. |
| `string`, `text`, `hash`, `csv` | `string`. |
| `integer`, `bigInteger`, `decimal` | `number`. |
| `boolean` | `boolean`. |
| `json` | `unknown`. |
| `uuid` | branded string khi có `branded`. |
| `date`, `datetime`, `time`, `timestamp` | `string`. |
| `geometry` | `GeoJSON.Geometry`. |
| `enum` choices | String literal union. |
| `encrypted: true` | Thêm `'***'` vì quyền decrypt phụ thuộc runtime permissions. |
| `readonly` hoặc `generated` | Emit property `readonly`. |
| `nullable: true` | Thêm `| null`. |
| `required: false` | Emit optional `?`. |
| `m2o` relation | Base field là target primary key type; expanded type là target object hoặc `null`. |
| `o2m` / `m2m` relation | Expanded type là array target objects. |
| `m2a` relation | `Array<{ collection: string; item: unknown }>` đến khi có collection union cụ thể. |

## 4. CLI

CLI nằm ở `apps/cms/scripts/typegen.ts`.

```sh
pnpm lumibase typegen \
  --site <siteId> \
  --out ./apps/web/src/lumibase-types.ts \
  --format single|per-collection \
  --include posts,tags \
  --exclude users
```

Flags:

- `--auth <token>` hoặc `LUMI_TOKEN`.
- `--url <api-url>`.
- `--branded` mặc định true và emit ID dạng `Brand<'PostId', string>`.

## 5. Manifest API

CLI gọi `GET /api/v1/typegen/schema?include=&exclude=`.

Manifest version `2` là public contract hiện tại:

```json
{
  "version": 2,
  "site": "site_xyz",
  "collections": [
    {
      "name": "posts",
      "primaryKey": "id",
      "primaryKeyField": "id",
      "primaryKeyType": "nanoid",
      "fields": [
        {
          "name": "id",
          "type": "string",
          "required": true,
          "nullable": false,
          "readonly": true,
          "generated": true,
          "system": true,
          "encrypted": false,
          "primaryKey": true,
          "branded": "PostsId"
        },
        {
          "name": "author_id",
          "type": "uuid",
          "required": false,
          "nullable": true,
          "readonly": false,
          "generated": false,
          "system": false,
          "encrypted": false,
          "primaryKey": false,
          "kind": "m2o",
          "target": "authors",
          "branded": "AuthorsId"
        }
      ],
      "relations": [
        {
          "field": "author_id",
          "kind": "m2o",
          "target": "authors",
          "manyCollection": "posts",
          "manyField": "author_id",
          "oneCollection": "authors",
          "oneField": "posts",
          "junctionCollection": null
        }
      ]
    }
  ]
}
```

Manifest gồm compiled system fields cùng user fields để generated apps có thể reference `id`, `status`, `sort`, audit fields và soft-delete fields với đúng metadata readonly/generated.

## 6. SDK usage

```ts
import { createLumiClient, legacyRest } from '@lumibase/sdk';
import type { LumibaseSchema } from './lumibase-types';

const client = createLumiClient<LumibaseSchema>({ url, token, siteId }).with(legacyRest());

const posts = await client.items('posts').list({
  fields: ['id', 'title', 'author_id'],
});
```

`createLumiClient` vẫn dùng được khi chưa generate types, nhưng generated schema giúp type-check collection names và item payloads tốt hơn.

## 7. Regeneration

Schema apply invalidate typegen cache keys và emit `schema.changed`. Project có thể regenerate types trong CI bằng cách lắng nghe event đó hoặc gọi CLI sau schema migrations/config imports.
