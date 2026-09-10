# `lumibase`

[LumiBase](https://lumibase.dev) in one package — the JS/TS client plus the `lumibase` CLI: generate TypeScript types from a live schema, check that your setup can reach the CMS, scaffold a project.

> **This is the client, not the server.** It talks to a LumiBase CMS you are
> already running. To run the CMS itself, use the image
> `ghcr.io/khuepm/lumibase-cms` or the [monorepo](https://github.com/khuepm/lumibase) —
> see [Deployment overview](https://docs.lumibase.dev/en/docs/deployment/overview).

```bash
npm install lumibase
```

```ts
import { createLumiClient, readItems } from 'lumibase';

const client = createLumiClient({ url: 'https://api.mysite.lumibase.dev', token, siteId });
const { data } = await client.request(readItems('articles', { limit: 10 }));
```

The library entry re-exports [`@lumibase/sdk`](https://www.npmjs.com/package/@lumibase/sdk) (REST + GraphQL + realtime, isomorphic ESM) — same client, one name to install. The CLI can also be run without installing:

```bash
npx lumibase --help
```

## Commands

| Command | What it does |
| --- | --- |
| `lumibase init [name]` | Scaffold a new project (runs `create-lumibase@<same version>` via `npx` / `pnpm dlx` / `yarn dlx` / `bunx`) |
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
lumibase types --import-from @lumibase/sdk    # module the generated file imports from (default: lumibase)
lumibase types --stdout                       # print instead of writing
```

The generated file imports its helper types from `lumibase` by default — the package you already have installed. Use `--import-from` (or `typegen.importFrom` in the config file) if your project depends on `@lumibase/sdk` directly.

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
