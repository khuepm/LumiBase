# Schema Type Generation

LumiBase typegen turns a tenant schema into TypeScript types for apps that use `@lumibase/sdk`. It is multi-tenant aware: the manifest is fetched for one site and can be filtered by collection.

## 1. Goals

- Generate TypeScript interfaces for collections, fields, system fields, and relations.
- Preserve primary key strategy, nullable/required, readonly/generated, encrypted field behavior, and relation-expanded response types.
- Keep the generated schema compatible with `createLumiClient<LumibaseSchema>()`.

## 2. Output Shape

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

Base interfaces represent stored item values. `CollectionExpanded` types represent read responses where relation fields may be expanded into related objects.

## 3. Mapping Rules

| Manifest input | Generated TypeScript |
|---|---|
| `primaryKeyType: "nanoid" | "uuid" | "string"` | `Brand<'CollectionId', string>` when branded, otherwise `ID`/`string`. |
| `primaryKeyType: "integer" | "bigInteger"` | `number`. |
| `string`, `text`, `hash`, `csv` | `string`. |
| `integer`, `bigInteger`, `decimal` | `number`. |
| `boolean` | `boolean`. |
| `json` | `unknown`. |
| `uuid` | branded string when `branded` is present. |
| `date`, `datetime`, `time`, `timestamp` | `string`. |
| `geometry` | `GeoJSON.Geometry`. |
| `enum` choices | String literal union. |
| `encrypted: true` | Adds `'***'` because decrypted access depends on runtime permissions. |
| `readonly` or `generated` | Emits `readonly` property. |
| `nullable: true` | Adds `| null`. |
| `required: false` | Emits optional `?`. |
| `m2o` relation | Base field is the target primary key type; expanded type is target object or `null`. |
| `o2m` / `m2m` relation | Expanded type is an array of target objects. |
| `m2a` relation | `Array<{ collection: string; item: unknown }>` until a collection union is available. |

## 4. CLI

The CLI lives in `apps/cms/scripts/typegen.ts`.

```sh
pnpm lumibase typegen \
  --site <siteId> \
  --out ./apps/web/src/lumibase-types.ts \
  --format single|per-collection \
  --include posts,tags \
  --exclude users
```

Flags:

- `--auth <token>` or `LUMI_TOKEN`.
- `--url <api-url>`.
- `--branded` defaults to true and emits `Brand<'PostId', string>`-style IDs.

## 5. Manifest API

The CLI calls `GET /api/v1/typegen/schema?include=&exclude=`.

Manifest version `2` is the current public contract:

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

The manifest includes compiled system fields alongside user fields so generated apps can reference `id`, `status`, `sort`, audit fields, and soft-delete fields with the correct readonly/generated metadata.

## 6. SDK Usage

```ts
import { createLumiClient, legacyRest } from '@lumibase/sdk';
import type { LumibaseSchema } from './lumibase-types';

const client = createLumiClient<LumibaseSchema>({ url, token, siteId }).with(legacyRest());

const posts = await client.items('posts').list({
  fields: ['id', 'title', 'author_id'],
});
```

`createLumiClient` remains usable without generated types, but generated schemas give collection names and item payloads stronger type checking.

## 7. Regeneration

Schema apply invalidates typegen cache keys and emits `schema.changed`. Projects can regenerate types in CI by listening to that event or by calling the CLI after schema migrations/config imports.
