---
version: 4
lastUpdated: 2026-11-15T12:00:14.900Z
sourceLang: en
contentHash: 9ff074b239a938f2
codeVerified: 2026-11-15T17:12:00.458Z
codeVerifiedHash: 9ff074b239a938f2
codeVerifiedClaims: 14
---

# Dynamic zones (`blocks` field)

> A **dynamic zone** is a field holding an ordered list of typed blocks — a hero, then a call-to-action, then a two-column layout — where every block type has its own schema. In LumiBase it is the `blocks` field type (issue #748, epic #676).

## 1. Model

### 1.1 Block templates are collections

A **block template** is an ordinary collection of the same site. Its user fields are the block's schema and its machine name is the block `type`. You author templates with the normal collection builder; nothing else is needed. A common convention is to mark template collections `hidden` so editors do not create stand-alone items in them.

Block data is stored **inline** in the owning item's JSONB `data`, not as items of the template collection. Deleting a page deletes its blocks; templates hold no rows of their own.

### 1.2 Field definition

```json
{
  "name": "sections",
  "type": "blocks",
  "interface": "blocks",
  "options": { "allowedBlocks": ["hero", "cta", "columns"], "min": 1, "max": 20 }
}
```

| Option | Meaning |
|---|---|
| `allowedBlocks` | Required, non-empty, unique collection machine names. Order is the order of the Studio picker and of the GraphQL union. |
| `min` / `max` | Optional integer bounds (0–500) on the number of blocks. `min` must not exceed `max`. |

A `required` blocks field needs at least one block. A blocks field cannot be `encrypted`. The definition is checked when the field is created or updated (`INVALID_FIELD_CONFIG`, HTTP 422). Template **existence** is checked when an item is written, so a schema apply or config import may create the field before its template collections.

### 1.3 Stored value

```json
[
  { "id": "V1StGXR8_Z5jdHi6B-myT", "type": "hero", "data": { "title": "Welcome" } },
  { "id": "Uakgb_J5m9g-0JDMbcJqL", "type": "cta", "data": { "label": "Start", "url": "https://example.com" } }
]
```

- `id` — a nanoid. Omit it on a new block and the server assigns one; existing ids are kept, so a block keeps its identity across reorders. Ids must be unique within one list.
- `type` — the template collection name; it is the union discriminator everywhere (REST, GraphQL, generated types).
- `data` — the block's field values, validated against the template.

## 2. Validation

Every write through `ItemService` (REST, GraphQL mutations, imports, agent tools) resolves the reachable templates and validates each block with the same validator the collection fields use (`validateItem` in `apps/cms/src/services/validation.ts`). Implementation: `apps/cms/src/services/blocks.ts`.

| Input | Result |
|---|---|
| `null` | Stored as `[]` (never crashes a reader — the Strapi #26816 class of bug). |
| missing (optional field) | Left missing; GraphQL reads it as `[]`. |
| `[]` | Accepted unless the field is `required` or `min` > 0. |
| block `data` `null`/missing | Treated as `{}`, then the template's required fields apply. |
| `type` not in `allowedBlocks` | Rejected at `<field>.<i>.type`. |
| template collection does not exist | Rejected at `<field>.<i>.type` (fails closed). |
| unknown block property (e.g. `__typename`) | Rejected at `<field>.<i>.<key>`. |
| unknown key inside `data` | Rejected at `<field>.<i>.data.<key>`. |
| value for an `encrypted` or `pii`/`phi` template field | Rejected — field encryption applies to top-level fields only. |
| duplicate or malformed `id` | Rejected at `<field>.<i>.id`. |

Errors are **path-precise**: a bad title three levels down reports `sections.0.data.items.1.data.title`. Every bad block is reported, not only the first.

Blocks may nest: a template can itself contain a `blocks` field. Nesting is limited to `MAX_BLOCK_DEPTH` = 5 levels, a list to `MAX_BLOCKS_PER_FIELD` = 500 blocks, and one write resolves at most 64 templates. A template that allows itself (recursion) is fine up to the depth limit.

Updates replace the whole list: a `PATCH` that sends `sections` sends the complete new order. Reorder, insert and remove are therefore plain array edits.

## 3. Permissions and masking

Field-level permissions and masks apply to the **whole `blocks` field as a unit**: a role either reads/writes `sections` or it does not. Permissions are not evaluated per block or per field inside a block, and template-level `hidden`/`readonly` flags are editorial hints only. Put data that needs its own permissions in a separate field or in a relation, not inside a block.

## 4. Filtering

Use the existing JSON containment operator to match items that contain a block of a given type. Pass the filter as JSON (the `filter=` form; bracket keys send strings, not arrays), URL-encoded on the wire:

```http
GET /api/v1/items/pages?filter={"sections":{"_json_contains":[{"type":"hero"}]}}
```

This is a `_some`-style match on block type (it can also match on block data, e.g. `[{"type":"cta","data":{"label":"Start"}}]`). There is no per-block `_every`/`_none` operator, and blocks fields are not sortable.

## 5. GraphQL

Each blocks field becomes a non-null list of a **union** of block object types (`apps/cms/src/graphql/schema-builder.ts`):

```graphql
union PagesSectionsBlocks = HeroBlock | CtaBlock | ColumnsBlock

type HeroBlock {
  id: ID!
  type: String!
  _data: JSON
  title: String
  subtitle: String
}
```

- Union name: `<Collection><Field>Blocks`; block type name: `<Template>Block`. A name already taken by another type gets a numeric suffix (`HeroBlock2`).
- Query with inline fragments and `__typename`:

```graphql
{ pages { sections { __typename ... on HeroBlock { id title } ... on CtaBlock { label url } } } }
```

- `null`/missing/garbage values resolve to `[]`; blocks whose type is no longer in the union (template deleted) are dropped from the response instead of erroring.
- A field whose allowed templates all no longer exist falls back to the `JSON` scalar.

## 6. Generated types and SDK

`GET /api/v1/typegen/schema` lists `allowedBlocks` on each blocks field, and `generateTypes` emits a discriminated union on `type`:

```ts
export interface HeroBlockData { title: string; subtitle?: string | null; }
export interface HeroBlock { id: string; type: "hero"; data: HeroBlockData; }

export interface Pages {
  sections?: Array<HeroBlock | CtaBlock> | null;
}
```

`<Template>BlockData` contains only the template's user fields (block data has no system columns). A template missing from the manifest becomes `{ id: string; type: "name"; data: Record<string, unknown> }`. For hand-written code the SDK exports `LumibaseBlock<TType, TData>`.

## 7. Studio

The `blocks` interface (`apps/studio/src/modules/content/interfaces/blocks.tsx`) offers:

- **Add** — one button per allowed type; disabled once `max` is reached.
- **Remove**, **collapse/expand** (`aria-expanded`), and **reorder** by dragging the handle, by keyboard on the handle (Space to lift, arrows to move, Space to drop), or with the Move up / Move down buttons. Changes are announced in a polite live region.
- A per-block form built from the template's fields with the regular interface registry, so nested blocks fields render the same editor.

Configure `allowedBlocks`/`min`/`max` in the field inspector's **Interface options** JSON. Blocks of a type that is no longer allowed stay visible with a warning instead of being silently dropped.

## 8. Multi-tenancy

- **Isolated per site:** block templates are collections of the site, resolved through the request's site-scoped `SchemaService.getCompiled`, so an `allowedBlocks` entry can never reach another site's collection — a name that does not exist in the site simply fails validation. Block data lives inside the site's own item rows (`site_id`), behind the same RLS and permission checks as any field.
- **Shared:** only code — the validator, the GraphQL builder and the limits above. No new table, cache key or setting.
- **How it is verified:** `apps/cms/src/services/__tests__/blocks.db.integration.test.ts` runs create/patch/filter against Postgres and a two-site case: site B's zone allowing `hero` is rejected because only site A has a `hero` collection, and site A is unaffected.

## 9. Not covered yet

- The live OpenAPI generator (#745, not on `main`) needs a `blocks` → JSON Schema mapping (`oneOf` over the templates, discriminated on `type`).
- Relations inside blocks are stored as plain ids and are not expanded by `fields=`/`deep`.
- Per-block permissions (see §3).
