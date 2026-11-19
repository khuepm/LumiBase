---
version: 6
lastUpdated: 2026-11-19T07:43:09.419Z
sourceLang: en
contentHash: c801a4dd4fa38995
codeVerified: 2026-11-19T07:43:09.419Z
codeVerifiedHash: c801a4dd4fa38995
codeVerifiedClaims: 24
---

# Backend templates

A **backend template** is one JSON document that describes a complete content
model: its collections, fields, validation, defaults, presentation metadata,
storage choices and relations, plus optional demo data. You can install the
same model into another site from it. Epic #900; specification
`.kiro/specs/backend-templates/`.

> **Status.** Available now: the template **format** and its validator in
> `@lumibase/contracts/backend-templates` (#901), and each site's private
> **catalog** (#902): drafts, published revisions and capture, and **plans**
> (#903), which preview an install without changing anything, and the
> **installation** of a plan (#904), including an optional seed pack (#905).
> MCP tools and Studio screens are delivered by #906–#909.

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

## Catalog

Each site keeps a private catalog under `/api/v1/backend-templates`. It is
open to **site admins** only, and it is scoped to the request's site: another
site's templates are not found, whatever id or slug is guessed. The tables are
`lumibase_backend_templates` and `lumibase_backend_template_revisions`, and
both are in the RLS `site_isolation` list. Official templates ship read-only
with the CMS (`GET /api/v1/backend-templates/official`) and are never copied
into a site. Code: `apps/cms/src/services/backend-templates/catalog-service.ts`.

- **Drafts.** `POST /` with `{ document }` creates a draft. The document is a
  JSON object, or raw JSON text, which is checked for duplicate keys. A draft
  may be incomplete: its `validation` lists what is missing. `PATCH /:id`
  takes `{ document, draftRevision }` and succeeds only if the draft is still
  at that revision. Of two edits made from the same revision, one wins and the
  other gets `409 DRAFT_CONFLICT`. The `slug` cannot change.
- **Publish.** `POST /:id/publish` validates the whole draft and stores an
  immutable revision of its `templateVersion`, as canonical JSON with its
  `sha256` digest. Publishing identical content again returns the existing
  revision (`200`, `meta.created: false`). Different content under a version
  that is already published is refused with `409 IMMUTABLE_REVISION`; publish
  a new `templateVersion` instead. An invalid draft gives
  `422 INVALID_TEMPLATE` with every error and its JSON path.
- **Export.** `GET /:id/revisions/:version` returns the published document.
- **Capture.** `POST /capture` with
  `{ collections, slug, displayName, templateVersion?, description?, seed? }`
  turns collections of the current site into a new draft. Only the named
  collections are captured. If they relate to a collection that was not named,
  the capture fails with `422 MISSING_DEPENDENCY` and the full `missing` list,
  rather than silently capturing more. Capture is schema-only and reads no
  item unless `seed: { collections, maxRecordsPerCollection?, pack? }` is
  given. Seed capture then reads items with the caller's own item permissions,
  drops `hash` and encrypted fields, and replaces ids with logical keys. If any
  read is denied, nothing is stored.

Creating, capturing and publishing are written to the audit log
(`backend_template_created`, `backend_template_captured`,
`backend_template_published`).

## Plan (preview)

`POST /api/v1/backend-templates/plans` previews installing one exact template
revision into the site of the request. It changes no schema and no content.
The only thing written is the plan row (`lumibase_backend_template_plans`,
scoped to the target site), and it expires after 15 minutes. Code:
`apps/cms/src/services/backend-templates/planner.ts`.

```json
{
  "template": { "source": "site", "sourceSiteId": "site_a", "slug": "blog", "version": "1.0.0" },
  "targetSiteId": "site_b",
  "namespace": { "prefix": "blog_" },
  "seedPack": null
}
```

- **Explicit target.** `targetSiteId` is required, and it must be the site of
  the request. A missing value is `400 MISSING_INPUT`; a different site is
  `400 SITE_MISMATCH`.
- **Exact template.** `source` is `official` (bundled) or `site` (a private
  catalog, `sourceSiteId` defaulting to the target). Name the template with
  `slug` plus `version`, or with `displayName` plus `version`. If a display name
  matches more than one template, across both catalogs, the request fails with
  `409 AMBIGUOUS_TEMPLATE` and lists the candidates. `digest` optionally pins
  the exact revision.
- **Separate authorization.** Reading another site's private catalog needs
  site admin on that source site as well; being admin of the target is not
  enough. Without it the template is reported as not found.
- **Namespace.** `prefix` is prepended to every collection name, and `map`
  renames individual collections. Only structural references are rewritten:
  collection names in collections, fields, relations, junctions and seed
  records. Descriptions, notes, options, display templates and seed values keep
  their text.
- **Create-only.** A target collection with the same name is
  `409 NAME_CONFLICT`, even when its schema is identical, and the response
  lists the conflicts. Templates never merge into, or replace, existing
  collections; choose a namespace instead. Unrelated collections are left
  alone.
- **Prerequisites.** The storage modes, the CMS version range
  (`compatibility.cmsVersionRange`) and a transactional runtime are checked
  before a plan is issued. A failure is `422 INCOMPATIBLE_RUNTIME`. When the
  CMS version is not stamped, the plan carries a warning instead.
- **Seed.** `seedMode` is `none` (the default) or `pack`, with `seedPack`
  naming the pack. A `seedPack` without `seedMode` means `pack`. `none` with a
  pack, or `pack` without one, is refused with `400`, and an unknown pack is
  `422 INVALID_TEMPLATE`.

The response (`201`) has the plan `id`, `expiresAt`, the target schema
`targetFingerprint` and a `report`. The report lists the collections,
relations and counts, the seed choice, the storage prerequisites, the conflicts
and the number of unrelated collections. `GET /plans/:id` reads a plan.
`POST /plans/:id/verify` checks it again: an expired plan is closed as
`expired`, a plan whose target schema changed since planning is closed as
`invalidated`, and both answer `409 STALE_PLAN`, after which you plan again.
The plan keeps a snapshot of the revision, so later edits to the source catalog
do not change it.

## Install

`POST /api/v1/backend-templates/installations` with `{ planId, idempotencyKey }`
applies a plan to the site of the request. Site admins only. Code:
`apps/cms/src/services/backend-templates/installer.ts`.

- **Atomic.** The collections, fields, relations, the selected seed pack and
  the installation record (`lumibase_backend_template_installations`) commit
  together in one database transaction, or none of them does. A runtime
  without transactions is refused (`422 INCOMPATIBLE_RUNTIME`); there is no
  partial fallback.
- **Re-checked under a lock.** A per-site lock serialises installs. Under it,
  the plan must still be open and unexpired, the target schema must match the
  plan's fingerprint, and the caller must still be a site admin. Otherwise the
  request is refused (`409 STALE_PLAN`, `403`) before anything is written. A
  same-name collection that appeared in the meantime is `409 NAME_CONFLICT`.
- **Idempotent.** The key is bound to the plan payload: target, plan, digest,
  namespace and seed pack. Retrying with the same key returns the committed
  installation (`200`, `meta.replayed: true`) and writes nothing new. Ten
  concurrent identical requests produce one installation. Using the same key
  with another plan is `409 IDEMPOTENCY_CONFLICT`. A plan is consumed once.
- **Effects after commit.** Schema-cache invalidation, the CDC dispatch and the
  `backend_template_installed` audit run only after commit. Schema change
  events are outbox rows inside the transaction, so a rollback leaves none. A
  failed install leaves the target exactly as it was, and is audited
  separately (`backend_template_install_failed`) without seed values.
- **Provenance.** The installation records the template identity and digest,
  the namespace, the seed pack, the installed (namespaced) template as the
  baseline for a future upgrade, and the created resources. Publishing a new
  revision never changes an installed backend.

`GET /api/v1/backend-templates/installations/:id` reads an installation of the
site.

## Seed packs at install

By default an install creates the schema only, with zero content items, even
when the template ships packs. A plan made with `seedMode: "pack"` and a
`seedPack` installs that pack's records inside the install transaction. Code:
`apps/cms/src/services/backend-templates/seed-writer.ts`.

- **As the caller.** Each record is created through the caller's own item
  service, bound to the transaction, so their item permissions and field
  validation apply. A record the caller may not create fails the whole install,
  and no schema or content remains.
- **Fresh ids.** Logical record keys become new ids. The same pack installed
  into two sites gets different ids, and its references resolve within each
  site. The installation keeps the key-to-id map in `resources.seedKeys`.
- **References.** Records are created in an order where every required
  reference already exists. An optional reference to a record created later is
  set by a second pass, so optional cycles such as two articles that point at
  each other work. Required cycles are refused by the validator before
  anything is written.
- **Nothing outside the data.** Seeding creates no users, credentials or files,
  and fetches nothing. Flows, webhooks, search indexing and extension hooks do
  not run on seed content, because the transaction-bound item service has no
  queue, search, cache or hooks.
- **Once.** Retrying a completed install returns it without reseeding. Content
  that a user edited afterwards stays as edited. Add more content later
  through the normal item API or MCP.

## Official template: `wordpress-alike` 1.0.0

A blog backend modelled on familiar WordPress concepts. It ships with the CMS
(`GET /api/v1/backend-templates/official`). The asset is
`apps/cms/src/services/backend-templates/official/wordpress-alike.template.json`,
and it targets CMS `>=2.1.0 <3.0.0`.

| Collection | Fields | Relations |
|---|---|---|
| `authors` | `name`*, `slug`*, `email`, `bio` | — |
| `posts` | `title`*, `slug`*, `excerpt`, `body`, `status` (draft · published · private), `published_at`, `author`, `comment_status` (open · closed), `featured` | `author` → `authors` |
| `pages` | `title`*, `slug`*, `body`, `status`, `parent`, `author`, `menu_order` | `parent` → `pages`, `author` → `authors` |
| `categories` | `name`*, `slug`*, `description`, `parent` | `parent` → `categories` |
| `tags` | `name`*, `slug`* | — |
| `post_categories` | `post`*, `category`* | junction: `post` → `posts`, `category` → `categories` |
| `post_tags` | `post`*, `tag`* | junction: `post` → `posts`, `tag` → `tags` |
| `comments` | `post`*, `author`, `author_name`*, `author_email`, `body`*, `status` (pending · approved · spam), `parent` | `post` → `posts`, `author` → `authors`, `parent` → `comments` |

`*` marks a required field. Every relation is m2o, and its alias is the field
name, so `author.name` or `parent.title` read through it. The taxonomy
junctions are explicit collections.

- **Authors are content profiles, not login accounts.** An author cannot sign
  in, and installing the template creates no user, role or permission.
- **Choices.** The `status` and `comment_status` choices are enforced on
  write. Their defaults (`draft`, `open`, `pending`) are pre-filled in Studio
  forms; the item API stores what it receives and does not fill them in.
- **Uniqueness.** `slug` fields are declared `unique`, but item writes do not
  enforce uniqueness on JSONB collections yet (backlog B240). Relation fields
  are not checked for an existing target on write either (B241).
- **Demo pack.** Without a seed pack the install is schema-only, and all eight
  collections are empty. The `demo` pack adds synthetic records to every
  collection and through every relation, including a child page, a child
  category and a reply comment. It contains no real people, accounts, files or
  secrets.
- **What it is not.** There is no PHP and no WordPress REST API
  compatibility, and there are no plugins, themes, media library contents or
  hosting. It is a content model, not a WordPress clone.
