---
version: 1
lastUpdated: 2026-08-01T23:58:19.962Z
sourceLang: en
contentHash: cfd657c0ddf0a6f6
codeVerified: 2026-08-01T23:58:19.962Z
codeVerifiedHash: cfd657c0ddf0a6f6
codeVerifiedClaims: 14
---

# LumiBase CLI

> `lumibase` — scaffold a project, generate types from a live schema, and check your setup.

The CLI is published as the unscoped package `lumibase` (`packages/cli/`). Install it as a dev dependency, or run it ad hoc with `npx`.

```bash
npm install -D lumibase
npx lumibase --help
```

Node.js 22+ is required; the launcher in `packages/cli/bin/lumibase.js` refuses older runtimes before loading the ESM graph.

## Commands

| Command | What it does |
| --- | --- |
| `lumibase init [name]` | Scaffold a new project |
| `lumibase types` | Generate TypeScript types from a running CMS |
| `lumibase doctor` | Report resolved configuration and probe connectivity |

`lumibase help` and `lumibase version` are also accepted, as are `--help` / `-h` and `--version` / `-v`.

## Connection settings

Every command that talks to a CMS resolves three settings with precedence **flag > environment > config file**:

| Setting | Flag | Environment | `lumibase.config.json` |
| --- | --- | --- | --- |
| CMS base URL | `--url` | `LUMIBASE_URL` | `url` |
| Site / tenant id | `--site` | `LUMIBASE_SITE_ID` | `siteId` |
| Bearer token | `--token` | `LUMIBASE_TOKEN` | — |

The token is deliberately **not** readable from the config file, because that file is meant to be committed. A `token` key there is rejected with an error rather than silently ignored — see `readConfigFile` in `packages/cli/src/config.ts`.

```json
{
  "url": "https://api.mysite.lumibase.dev",
  "siteId": "site_abc123",
  "typegen": {
    "out": "src/lumibase-types.d.ts",
    "exclude": ["internal_logs"]
  }
}
```

The config file is looked up from the working directory upward until the filesystem root, so it resolves from any package inside a monorepo.

Requests are sent with `Authorization: Bearer <token>` and `X-Lumi-Site: <siteId>` — the same headers the SDK client uses.

## `lumibase init`

Delegates to `create-lumibase`, which stays the single implementation of the scaffold so `npm create lumibase` and `lumibase init` can never drift. All arguments are forwarded verbatim:

```bash
lumibase init my-site --template cloudflare --pm pnpm
```

## `lumibase types`

Fetches the collection manifest from `GET /api/v1/typegen/schema` (served by `apps/cms/src/routes/typegen.ts`) and renders it with `generateTypes` from `@lumibase/sdk`.

```bash
lumibase types                                # -> lumibase-types.d.ts
lumibase types --out src/lumibase-types.d.ts  # custom path; directories are created
lumibase types --include articles,authors     # only these collections
lumibase types --exclude internal_logs        # skip these collections
lumibase types --no-branded                   # plain string ids instead of branded ones
lumibase types --stdout                       # print instead of writing a file
```

The generated file imports types from `@lumibase/sdk`, so that package must be installed in the project consuming them.

### Deterministic output and `--check`

The generated header carries no timestamp, host, or site id. Two machines pointed at the same schema produce byte-identical files, which makes the output safe to commit and verify in CI:

```yaml
- run: npx lumibase types --check
```

`--check` exits non-zero when the file is missing or stale, and never writes anything. Without `--check`, an unchanged file is left untouched rather than rewritten, so watchers do not rebuild for nothing.

## `lumibase doctor`

Prints what was resolved, where each value came from, and whether the CMS answers:

```
✔ node         v22.22.2
✔ config       /path/to/lumibase.config.json
✔ url          http://localhost:1989 (from lumibase.config.json)
✔ siteId       site_abc123 (from lumibase.config.json)
✔ token        tok_••••••••3f (from environment)
✔ health       reachable — status: healthy
✔ schema       12 collections readable
```

The health probe calls the unauthenticated `/health` endpoint (`apps/cms/src/routes/health.ts`); the schema check exercises the same authenticated request `lumibase types` makes, so a green `doctor` means typegen will work. Tokens are masked: a short prefix is kept so an operator can tell which token was picked up without the value reaching CI logs.

`doctor` exits non-zero if any check fails.

## Related

- [SDK — typegen](../sdk/typegen.md) — the programmatic API behind `lumibase types`
- [Getting started](../getting-started.md) — running a CMS to point the CLI at
- [npm publishing](../release/npm-publishing.md) — how the package is released
