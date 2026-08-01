# `@lumibase/contracts`

Shared Zod schemas, TypeScript types, policy DSL, and field DSL for [LumiBase](https://lumibase.dev). Pure data/contracts layer — no Hono, React, or database runtime dependencies.

```bash
npm install @lumibase/contracts
# or
pnpm add @lumibase/contracts
```

## When to use this

Install `@lumibase/contracts` when an external tool, CLI, linter, or codegen step needs to **validate or type** LumiBase artefacts without running the CMS:

- Validate `config` manifests / NDJSON backups
- Share policy / field DSL types with a custom admin or extension host
- Read CDC feed / extension / consent schemas from a worker or sidecar

If you are calling the CMS HTTP API from an app, prefer [`@lumibase/sdk`](https://www.npmjs.com/package/@lumibase/sdk) instead.

## Entry points

| Import | Contents |
| --- | --- |
| `@lumibase/contracts` | Core types + re-exports |
| `@lumibase/contracts/schemas` | Zod schemas (CDC, config manifest, flows, uploads, …) |
| `@lumibase/contracts/policy` | Policy DSL types |
| `@lumibase/contracts/field` | Field DSL types |
| `@lumibase/contracts/extensions` | Extension manifest / signature helpers |
| `@lumibase/contracts/version` | `BuildMetadata` |
| `@lumibase/contracts/utils` | Shared logger helper |

```ts
import { extensionManifestSchema } from '@lumibase/contracts/schemas'

const parsed = extensionManifestSchema.parse(JSON.parse(raw))
```

## Peer / runtime note

Depends on **Zod v4**. No other runtime deps.

## Related packages

| Package | Role |
| --- | --- |
| [`@lumibase/sdk`](https://www.npmjs.com/package/@lumibase/sdk) | Typed REST / realtime client |
| [`@lumibase/extension-sdk`](https://www.npmjs.com/package/@lumibase/extension-sdk) | Author hooks & UI extensions |
| [`@lumibase/mcp-server`](https://www.npmjs.com/package/@lumibase/mcp-server) | Stdio MCP server |

## License

Apache-2.0 — part of the [LumiBase](https://github.com/khuepm/lumibase) monorepo.
