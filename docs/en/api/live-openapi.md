---
sourceLang: en
version: 2
lastUpdated: 2026-11-15T08:37:17.584Z
contentHash: 3c24ed16f8d5e8dc
codeVerified: 2026-11-15T08:37:17.584Z
codeVerifiedHash: 3c24ed16f8d5e8dc
codeVerifiedClaims: 18
---

# Live OpenAPI document

> `GET /api/v1/openapi.json` — an OpenAPI 3.1 document generated from your site's live schema, filtered by who is asking. Off by default.

## Overview

The static [`docs/openapi.yaml`](../../openapi.yaml) describes the platform. The live document describes **your site**: one path pair per collection, one component schema per collection, with the field types, relations, files and localized fields you actually configured.

It is generated per caller. The same URL returns a different document for an editor, a subscriber and an anonymous visitor, because it lists only:

- collections the caller can **read** (a collection without a `read` permission is never named — not in paths, schemas or `$ref`s);
- fields the caller's **field mask** lets through — the same `applyFieldMask` rule `PermissionService.maskItem` applies to real reads, so a field stripped from responses is also absent from the document;
- operations the caller holds (`create` → `POST`, `update` → `PATCH`, `delete` → `DELETE`). Write bodies only contain fields the caller can both write and read.

The `public` realm (anonymous callers, ADR-011) always gets the **read-only** surface, even if a grant would allow more.

Implementation: `apps/cms/src/routes/openapi.ts`, generator in `apps/cms/src/services/openapi/`.

## Enable it

The endpoint is disabled on every site until a site admin turns it on. While disabled — or when the caller's realm is not allowed — it answers with **the same 404 body as an unknown route**, so its existence is not revealed.

From Studio: **Settings → Developer → Types → Live OpenAPI document**. Tick *Enable* and choose who may fetch it.

From the API (site admin):

```bash
curl -X PUT "$LUMI_URL/api/v1/openapi/config" \
  -H "Authorization: Bearer $LUMI_TOKEN" \
  -H "X-Lumi-Site: $SITE" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": true, "realms": ["studio", "api_key"] }'
```

`GET /api/v1/openapi/config` reads the current value. The value is stored in the existing `settings` table under the key `openapi` (no migration); a missing or malformed row reads as disabled. Every change is audited as `openapi_config_updated`.

| Realm | Who |
|---|---|
| `studio` | Staff sessions (token audience `studio`), Cloudflare Access, dev admin tokens |
| `frontend` | Subscriber sessions (token audience `frontend`) and users from a trusted external issuer |
| `api_key` | Any site API key, publishable or secret |
| `public` | Anonymous callers resolved to the site's `public` role — requires public access to be enabled under **Access → Public & subscribers** |

## Fetch it

```bash
curl "$LUMI_URL/api/v1/openapi.json" \
  -H "Authorization: Bearer $LUMI_TOKEN" \
  -H "X-Lumi-Site: $SITE"
```

The response is the OpenAPI document itself (not wrapped in `{ data }`), with `Cache-Control: private, no-cache` and an `ETag`; send `If-None-Match` to get a `304`.

`servers` is the relative URL `/api/v1`, resolved against the document's own URL — no host is baked in.

## What the document contains

Per readable collection `<name>`:

| Component | Shape |
|---|---|
| `<name>.Item` | Default read shape: system columns at the top level (`id`, `status`, `sort`, `createdAt`, …) and user fields under `data` |
| `<name>.Fields` | The readable user fields (`data`) |
| `<name>.Projection` | Flat shape returned when the request passes `fields=` (system columns in snake_case, relations and files expandable with `rel.*`) |
| `<name>.CreateInput` / `<name>.UpdateInput` | Request bodies — only when the caller holds `create` / `update` |

Paths: `/items/<name>` (`GET` list with `fields`, `filter`, `sort`, `limit`, `offset`, `status`, `meta`; `POST` when allowed) and `/items/<name>/{id}` (`GET`; `PATCH`/`DELETE` when allowed), plus the public delivery endpoint `/deliver/page/{site_id}/{slug}` (`locale`/`lang`). Success bodies use `{ data, meta? }`; failures use `{ errors: [...] }`.

Field types map exactly as `lumibase typegen` maps them (`apps/cms/src/services/openapi/field-schema.ts` mirrors `packages/sdk/src/typegen/index.ts`):

| Field | JSON Schema |
|---|---|
| `string`, `text`, `hash`, `csv` | `string` |
| `integer`, `bigInteger` | `integer` |
| `decimal` | `number` |
| `boolean` | `boolean` |
| `json` | any (`{}`) |
| `uuid`, `date`, `datetime`, `time`, `timestamp` | `string` with `format` |
| `geometry` | GeoJSON object |
| choices (`validation.rules[choices]`) | `enum` |
| `translatable-text` interface | object of locale → string |
| `file` / `files` interface | file id / array of file ids (expandable in the projection) |
| m2o relation | target's primary key (expandable to the target projection when readable) |
| o2m / m2m alias | array of target primary keys |

Nullable or optional fields allow `null`, exactly like typegen's `| null`. Encrypted fields read by a caller without `read_decrypted` are documented as their type **or** the mask `'***'`.

## Caching

Documents are cached in the runtime cache (`c.get('runtime').cache` — KV on Workers, Redis on Docker) under `openapi:<site>:s<schema version>:<permission fingerprint>`:

- the **schema version** is a per-site pointer bumped by `SchemaService.invalidate` on every collection, field or relation change (`apps/cms/src/services/schema-version.ts`), so a schema change orphans every cached document for the site in one write;
- the **permission fingerprint** is a digest of the caller's realm and compiled permission bundle (only the actions the document uses). Callers with identical access share one entry; a permission change produces a new fingerprint.

Entries expire after 300 seconds as a safety net when a version bump is lost. A cache outage degrades to regenerating, never to an error.

## Multi-tenancy

Everything is isolated per site; nothing is shared across tenants except the generator code. The switch is a `settings` row scoped by `site_id`, the manifest is read with `scopeSite`, the schema-version pointer is `schema-ver:<site>` and every cached document key starts with `openapi:<site>:`. A site that has not enabled the endpoint answers 404 regardless of what another site allows. Verified by `apps/cms/src/routes/__tests__/openapi.test.ts` (two sites sharing one cache; two principals sharing one cache).

## Use it with typegen and SDK tooling

Any OpenAPI 3.1 tool can consume it. With [`openapi-typescript`](https://openapi-ts.dev):

```bash
npx openapi-typescript "$LUMI_URL/api/v1/openapi.json" \
  -H "Authorization: Bearer $LUMI_TOKEN" -H "X-Lumi-Site: $SITE" \
  -o ./lumibase-openapi.ts
```

```ts
import type { components, paths } from './lumibase-openapi';

type Post = components['schemas']['posts.Fields'];
type PostList = paths['/items/posts']['get']['responses'][200]['content']['application/json'];
```

The CMS test suite runs exactly this (`apps/cms/src/services/openapi/__tests__/openapi-consumers.test.ts`): it generates types from a document covering every field type and type-checks a consumer against them, and asserts that every scalar field type gets the same TypeScript type from `openapi-typescript` as from `lumibase typegen`. The generated documents are validated against the official OpenAPI 3.1 schema, including property-based runs over random schemas and permission masks that check no hidden field or collection ever appears.

`lumibase typegen` remains the native path (it also emits branded ids and `*Expanded` relation types); the live document is for tools that speak OpenAPI — client generators, Postman, contract tests, API gateways.

## Browse it in the docs site

The docs site has an API explorer page (`/en/api-explorer/` · `/vi/api-explorer/`): a bundled Swagger UI that loads a document URL you type in. Nothing is fetched until you press **Load**, the page ignores `?url=` query parameters, and the optional site id and token stay in the tab's memory and are only sent to the document's own origin. Your CMS must allow the docs origin in CORS for the browser to fetch the document.
