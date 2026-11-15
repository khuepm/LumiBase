---
title: Typegen configs and output targets
sourceLang: en
version: 1
lastUpdated: 2026-11-15T16:52:33.839Z
contentHash: 87ae65be8601739a
codeVerified: 2026-11-15T16:52:33.839Z
codeVerifiedHash: 87ae65be8601739a
codeVerifiedClaims: 8
---

# Typegen configs and output targets

> One `lumibase types` run, several configs, several outputs: TypeScript, Zod validators, GraphQL SDL and an OpenAPI 3.1 document — from a live CMS or from a saved manifest.

`lumibase types` on its own writes one TypeScript file (see the [CLI guide](./index.md#lumibase-types)). When a project needs more — a web app and an admin app reading different collections, a Zod file for runtime validation, an SDL file for a GraphQL client generator — put the setup in a **typegen config file** instead of on the command line.

## The config file

`lumibase types` looks for, walking up from the working directory, the first of:

- `lumibase.typegen.config.ts`
- `lumibase.typegen.config.mts`
- `lumibase.typegen.config.js`
- `lumibase.typegen.config.mjs`
- `lumibase.typegen.config.json`

(`TYPEGEN_CONFIG_FILENAMES` in `packages/cli/src/typegen/load-config.ts`), or the file passed with `--config <path>`. When one is found, every config in it runs; without one, `lumibase types` keeps its single-file behaviour.

The file exports one config or an **array** of configs:

```ts
// lumibase.typegen.config.ts
import { defineTypegenConfig } from 'lumibase'

export default defineTypegenConfig([
  {
    name: 'web',
    include: ['articles', 'authors'],
    targets: [
      { type: 'ts', out: 'apps/web/src/lumibase-types.d.ts' },
      { type: 'zod', out: 'apps/web/src/lumibase-schemas.ts' },
    ],
  },
  {
    name: 'admin',
    source: { urlEnv: 'STAGING_LUMIBASE_URL', site: 'site_admin', tokenEnv: 'STAGING_LUMIBASE_TOKEN' },
    exclude: ['internal_logs'],
    targets: [
      { type: 'graphql-sdl', out: 'apps/admin/schema.graphql' },
      { type: 'openapi', out: 'apps/admin/openapi.json' },
    ],
  },
])
```

A `.ts` / `.mts` config is loaded with [jiti](https://github.com/unjs/jiti), a small dependency-free loader (the one ESLint and Tailwind use for their TypeScript configs), because Node 22 before 22.18 cannot import TypeScript without a flag. It is imported only when the config is TypeScript; `.js`, `.mjs` and `.json` configs use Node directly.

Output and manifest paths are relative to the config file. Two targets may not write the same path — the run refuses before fetching anything.

### Config keys

| Key | Type | Description |
|-----|------|-------------|
| `name` | `string` | Label in log lines (default `config #<n>`) |
| `source` | object | Where the manifest comes from — see below (default: the usual connection settings) |
| `include` | `string[]` | Only these collections |
| `exclude` | `string[]` | Skip these collections |
| `targets` | array | One or more outputs (required) |

### Sources

**Live CMS** — `{ url?, site?, urlEnv?, siteEnv?, tokenEnv? }`. Each value falls back to the usual resolution (flag > environment > `lumibase.config.json`). `urlEnv` / `siteEnv` / `tokenEnv` name the environment variable to read, so two configs can point at two sites with two tokens; a named variable that is unset is an error, not a silent fallback. A `token` key is refused: the config file is meant to be committed.

**Saved manifest** — `{ manifest: './lumibase.manifest.json' }`. Reads a file holding the manifest, or the raw `GET /api/v1/typegen/schema` response (`{ data: … }`). No network, no token — useful in CI jobs that cannot reach a CMS. Write one with the `manifest` target.

Configs that share a source share one fetch per run; `include` / `exclude` are applied per config.

### Targets

| `type` | Output | Options |
|--------|--------|---------|
| `ts` | TypeScript interfaces — the existing `generateTypes` output | `branded` (default `true`), `importFrom` (default `lumibase`) |
| `zod` | Zod validators: `<Name>Schema`, `type <Name> = z.infer<…>`, `LumibaseSchemas` map | `importFrom` (default `zod`) |
| `graphql-sdl` | SDL of the schema the CMS serves at `/graphql` | — |
| `openapi` | OpenAPI 3.1 document with `components.schemas` (JSON) | `title`, `version` |
| `manifest` | The manifest itself (JSON, site id removed) | — |

Every output is deterministic — no host, site id or timestamp — so `--check` gives the same answer against any instance with the same schema.

## What each target emits

The generators live in the SDK (`packages/sdk/src/typegen/`) and are exported from `@lumibase/sdk` as `generateTypes`, `generateZod`, `generateGraphQLSdl` and `generateOpenApi`, so they can also be called from your own script.

**Field mapping shared by `ts`, `zod` and `openapi`:** a field that is not `required` is optional; a field that is not required or is `nullable` also accepts `null`. A field with the `translatable-text` interface is a per-locale map (`Partial<Record<Locale, string>>` in TS); a `file` field is a file id string; a `files` field is an array of file ids; `json` is `unknown`; an encrypted field may also be `'***'` (masked for callers without `read_decrypted`).

**`zod`** follows the TS types with two deliberate differences, both toward what the API returns: branded ids validate as plain strings (a brand is a compile-time marker only), and to-many relations accept an id *or* an expanded object per entry. The generated file uses only API shared by Zod 3 and Zod 4.

**`graphql-sdl`** mirrors `apps/cms/src/graphql/schema-builder.ts`: the same type names (`blog_posts` → `BlogPosts`), the structural columns (`id`, `status`, `sort`, `createdAt`, …, `_data`), the scalar mapping of `type-mapping.ts`, nested m2o fields and o2m list fields, and the `Query` / `Mutation` / `Subscription` roots. A test (`apps/cms/src/graphql/__tests__/sdl-parity.test.ts`) builds both and compares them field by field. Against a CMS older than this release the manifest lacks each relation's stored type, so one-side o2m fields are left out.

**`openapi`** uses the component names of the live per-caller document: `<collection>.Fields`, `.Item` (system columns at the top level, user fields under `data`), `.Projection` (the flat `?fields=` shape), `.CreateInput`, `.UpdateInput`, plus the `{ data, meta }` envelopes `.Response` and `.ListResponse`, and the shared `PaginationMeta`, `ErrorObject` and `ErrorResponse`. Nullable fields use `type: [T, 'null']`, enums use `enum`. It documents every collection in the manifest; it has no paths and no per-role view.

## `--check` in CI

```bash
lumibase types --check
```

Renders every target of every config, compares each with the file on disk, prints one line per output and exits `1` when any is missing or stale. Nothing is written.

## `--watch`

```bash
lumibase types --watch                 # poll every 2 s
lumibase types --watch --interval 5000
```

Runs once, then polls each distinct source and regenerates only the configs whose source changed:

- **Live CMS** — `GET /api/v1/typegen/schema` now returns a weak `ETag`, and the watcher sends `If-None-Match`; a `304` means nothing to do. A CMS without ETag support still works: an identical body is treated as unchanged.
- **Saved manifest** — the file's mtime and size are checked each round, then its content.

A failing poll backs off exponentially (doubling, up to 60 s) and returns to the normal interval after the next success. `Ctrl+C` stops it. `--watch` also works without a config file, for the single TypeScript output the flags describe. It does not reload the config file itself — restart after editing it.

## Flags and the config file

With a config file, the single-output flags `--out`, `--include`, `--exclude`, `--no-branded`, `--import-from` and `--stdout` are refused rather than silently ignored — set those in the config. `--url`, `--site` and `--token` still apply, as defaults for live sources.

## Related

- [CLI guide](./index.md) — connection settings and the other commands
- [SDK — typegen](../sdk/typegen.md) — calling the generators from code
