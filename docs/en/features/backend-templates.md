---
version: 1
lastUpdated: 2026-11-19T06:06:09.106Z
sourceLang: en
contentHash: 6bda70c8176b1e84
codeVerified: 2026-11-19T06:06:09.106Z
codeVerifiedHash: 6bda70c8176b1e84
codeVerifiedClaims: 2
---

# Backend templates

A **backend template** is one JSON document that describes a complete content
model: its collections, fields, validation, defaults, presentation metadata,
storage choices and relations, plus optional demo data. You can install the
same model into another site from it. Epic #900; specification
`.kiro/specs/backend-templates/`.

> **Status.** This page documents the template **format** and its validator,
> which are available now in `@lumibase/contracts/backend-templates` (#901).
> The template catalog, preview/plan, governed installation, MCP tools and
> Studio screens are delivered by #902–#909. Until those land, nothing in the
> CMS reads or installs a template.

Code: `packages/contracts/src/backend-templates/` (`envelope.ts`, `validate.ts`, `ingest.ts`, `canonical.ts`, `limits.ts`). Tests: `packages/contracts/src/backend-templates/__tests__/backend-template-contract.test.ts`.

## The document

```json
{
  "formatVersion": "lumibase.template@v1",
  "slug": "wordpress-alike",
  "displayName": "WordPress alike",
  "templateVersion": "1.0.0",
  "description": "Posts, pages, taxonomies and comments.",
  "compatibility": { "cmsVersionRange": ">=2.2.0 <3.0.0", "storageModes": ["jsonb"] },
  "config": {
    "version": "lumibase.config@v1",
    "collections": [{ "name": "authors" }, { "name": "posts" }],
    "fields": [
      { "collection": "authors", "field": "name", "type": "string", "interface": "input", "required": true },
      { "collection": "posts", "field": "title", "type": "string", "interface": "input", "required": true },
      { "collection": "posts", "field": "author", "type": "string", "interface": "input" }
    ],
    "relations": [
      { "manyCollection": "posts", "manyField": "author", "oneCollection": "authors", "type": "m2o" }
    ]
  },
  "seedPacks": {
    "demo": {
      "records": [
        { "key": "author-1", "collection": "authors", "values": { "name": "Demo author" } },
        { "key": "post-1", "collection": "posts", "values": { "title": "Hello" }, "references": { "author": "author-1" } }
      ]
    }
  }
}
```

| Property | Required | Meaning |
|---|---|---|
| `formatVersion` | yes | Always `lumibase.template@v1`. Any other value is `UNSUPPORTED_FORMAT`. |
| `slug` | yes | Kebab-case identifier, up to 64 characters. |
| `displayName` | yes | Up to 120 characters. |
| `templateVersion` | yes | [SemVer 2.0.0](https://semver.org), for example `1.0.0` or `1.1.0-beta.1`, without a `v` prefix. It is independent of the CMS version. |
| `description` | no | Up to 4000 characters. Shown to people; it is never treated as an instruction. |
| `compatibility` | yes | `cmsVersionRange` (a SemVer range) and the `storageModes` the collections use. |
| `config` | yes | A config manifest (`lumibase.config@v1`, the same format as config export/import): `collections` (at least one), `fields`, `relations`. |
| `seedPacks` | no | Named demo data. When it is omitted, the template is schema-only. Installing never seeds unless a pack is chosen. |

Collection, field and relation entries are exactly the config-manifest
entries, so they use the same names and options as the schema API.

## What a template may not contain

The envelope is strict, and an unknown key anywhere is refused. This keeps the
following out of a template:

- **Identity:** record ids, site ids, `createdAt` / `updatedAt`, or a field
  named `id` or `site_id`. Ids are generated when a template is installed.
- **Code and side effects:** SQL, migrations, flows, extensions,
  `config.webhooks`, `config.settings` (which may hold secrets) and
  `config.managedScopes`. Empty `webhooks` / `settings` lists are accepted and
  dropped.
- **Access:** permissions, roles and users.
- **Secrets:** seed values for `hash` fields.
- **Platform resources:** collections marked `system`, names starting with
  `lumibase_` or `mat_`, and primary keys other than `nanoid` named `id`.

## Seed packs

A pack is `{ description?, records: [...] }`. Each record has:

- `key`: a logical key, unique within the pack. It is never a persisted id.
- `collection`: a declared collection.
- `values`: values by field name. They must fit the field type, and they
  cannot include relation, alias or hash fields.
- `references` (optional): an m2o relation field mapped to the key of another
  record **in the same pack**, or `null`. The target must be a record of the
  relation's target collection. References outside the pack are refused.

Required fields must be present, unless they have a default. Required
references cannot form a cycle, because such records could not be inserted.

## Validation

```ts
import { parseBackendTemplate, templateDigest, exportBackendTemplate } from '@lumibase/contracts/backend-templates';

const result = parseBackendTemplate(jsonText);        // raw text: duplicate keys, size and depth checked
if (!result.ok) console.log(result.errors);           // [{ code, path: '$.config.fields[3].type', message }]
const digest = await templateDigest(result.template); // 'sha256:…'
```

`parseBackendTemplate` reads raw JSON text and refuses duplicate keys, where
plain `JSON.parse` would keep the last one. `validateBackendTemplate` takes a
value that is already parsed. Both report **every** problem they find. Each
problem has a stable code and a JSON path:

| Code | When |
|---|---|
| `UNSUPPORTED_FORMAT` | `formatVersion` or `config.version` is not one this CMS reads |
| `INVALID_TEMPLATE` | The structure is wrong, or a key is duplicated, a reference dangles, a name is reserved, a field type is unknown, a seed value does not fit its field, or a required cycle exists |
| `INCOMPATIBLE_RUNTIME` | A storage mode or relation type that template v1 cannot install, such as `physical`, `materialized`, `external` or `m2a`. These are refused, never downgraded. |
| `LIMIT_EXCEEDED` | A limit below is exceeded |

The other codes (`AMBIGUOUS_TEMPLATE`, `SITE_MISMATCH`, `NAME_CONFLICT`,
`STALE_PLAN`, `APPROVAL_REQUIRED`, `IDEMPOTENCY_CONFLICT`) are reserved for
the catalog and install steps.

`backendTemplateJsonSchema()` returns the JSON Schema (draft 2020-12) of the
envelope. It is generated from the same Zod schema, so an external validator
accepts and refuses the same documents structurally. The cross-reference rules
above are applied only by the validator.

## Limits

| Limit | Value |
|---|---|
| Document | 2 MiB (UTF-8 bytes of the JSON text) |
| Nesting depth | 32 (the top-level object is depth 1) |
| Collections | 100 |
| Fields | 2000 |
| Relations | 500 |
| Seed records, across all packs | 1000 |
| Seed values, across all packs | 1 MiB (UTF-8 of each record's `values` and `references`) |

A document exactly at a limit is accepted when everything else is valid. One
over the limit is refused with `LIMIT_EXCEEDED`. Nothing is truncated.

## Canonical form and digest

`canonicalTemplate` sorts object keys. It also sorts collections, fields,
relations, seed records and `compatibility.storageModes` by their stable key,
because their order means nothing (field order is `sortOrder`). Every other
array keeps its order. `config.exportedAt` is dropped.
`templateDigest` is SHA-256 over the canonical bytes, seed packs included. Two
documents that differ only in key or list order therefore have the same digest,
and any change to a field or a seed value changes it.
`exportBackendTemplate` returns the canonical object.
