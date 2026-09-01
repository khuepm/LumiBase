# `lumibase`

The CLI for [LumiBase](https://lumibase.dev) — scaffold a project, generate TypeScript types from a live schema, and check that your setup can reach the CMS.

```bash
npm install -D lumibase
# or run it without installing
npx lumibase --help
```

## Commands

| Command | What it does |
| --- | --- |
| `lumibase init [name]` | Scaffold a new project (delegates to `create-lumibase`) |
| `lumibase types` | Generate TypeScript types from a running CMS |
| `lumibase doctor` | Report resolved configuration and probe connectivity |

## Connection settings

Resolved with precedence **flag > environment > `lumibase.config.json`**:

| Setting | Flag | Environment | Config file |
| --- | --- | --- | --- |
| CMS base URL | `--url` | `LUMIBASE_URL` | `url` |
| Site / tenant id | `--site` | `LUMIBASE_SITE_ID` | `siteId` |
| Bearer token | `--token` | `LUMIBASE_TOKEN` | — |

The token is deliberately **not** readable from the config file — that file is meant to be committed. A `token` key there is rejected with an error rather than silently ignored.

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

The file is looked up from the working directory upward, so it works from any package inside a monorepo.

## `lumibase types`

Fetches the collection manifest from `GET /api/v1/typegen/schema` and writes TypeScript definitions.

```bash
lumibase types                                # -> lumibase-types.d.ts
lumibase types --out src/lumibase-types.d.ts  # custom path (directories are created)
lumibase types --include articles,authors     # subset of collections
lumibase types --no-branded                   # plain string ids
lumibase types --stdout                       # print instead of writing
```

The generated file imports from `@lumibase/sdk`, so install that in the project consuming the types.

Output is **deterministic** — no timestamp, host, or site id in the header — so the file can be committed and verified in CI:

```yaml
- run: npx lumibase types --check
```

`--check` exits non-zero when the committed file is missing or stale, and never writes anything.

## `lumibase doctor`

```
✔ node         v22.22.2
✔ config       /path/to/lumibase.config.json
✔ url          http://localhost:1989 (from lumibase.config.json)
✔ siteId       site_abc123 (from lumibase.config.json)
✔ token        tok_••••••••3f (from environment)
✔ health       reachable — status: healthy
✔ schema       12 collections readable
```

Exits non-zero if any check fails. Tokens are masked — a short prefix is kept so you can tell *which* token was picked up without the value reaching CI logs.

## Requirements

Node.js 22+.

## Links

- Documentation — <https://docs.lumibase.dev>
- Issues — <https://github.com/khuepm/lumibase/issues>

Apache-2.0
