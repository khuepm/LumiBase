# `@lumibase/sdk`

Typed JavaScript/TypeScript client for a running [LumiBase](https://lumibase.dev) CMS — REST commands, GraphQL helper, realtime subscriptions, and TypeScript type generation.

```bash
npm install @lumibase/sdk
# or
pnpm add @lumibase/sdk
```

## Quick start

```ts
import { createLumiClient, readItems } from '@lumibase/sdk'

const client = createLumiClient({
  url: 'https://api.mysite.lumibase.dev',
  siteId: 'site_abc123',
  token: process.env.LUMIBASE_TOKEN!,
})

const articles = await client.request(
  readItems('articles', {
    filter: { status: { _eq: 'published' } },
    sort: ['-created_at'],
    limit: 10,
  }),
)
```

## What you get

| Surface | Entry | Notes |
| --- | --- | --- |
| Transport | `createLumiClient` | Tree-shakeable `request` / `rawRequest` / `with` |
| REST commands | `@lumibase/sdk` REST exports | `readItems`, CDC, agents, search, … |
| Legacy façade | `legacyRest()` | Namespaced API if you prefer not to import commands |
| GraphQL | GraphQL helper | Against the CMS GraphQL endpoint |
| Realtime | `RealtimeClient` | WebSocket subscriptions |
| Typegen | `generateTypes` | Produce TS types from a live schema |
| SEO helpers | `seo` exports | Delivery helpers for meta/structured data |

The client is a **transport**, not a façade: you import only the commands you use. There is no `login()` — pass a Bearer token (and optional `refreshToken`) you already hold.

## Requirements

- A running LumiBase CMS (Docker image, Cloudflare Worker, or local monorepo `pnpm cms:dev`)
- Node.js 18+ / modern browsers / Cloudflare Workers (`fetch`-compatible runtimes)

## Docs

- [JavaScript SDK](https://docs.lumibase.dev/en/sdk/javascript)
- [Typegen](https://docs.lumibase.dev/en/sdk/typegen)
- [Next.js quickstart](https://docs.lumibase.dev/en/tutorials/nextjs-quickstart)

## Related packages

| Package | Role |
| --- | --- |
| [`create-lumibase`](https://www.npmjs.com/package/create-lumibase) | Scaffold a starter project |
| [`@lumibase/contracts`](https://www.npmjs.com/package/@lumibase/contracts) | Shared Zod schemas / policy & field DSLs |
| [`@lumibase/extension-sdk`](https://www.npmjs.com/package/@lumibase/extension-sdk) | Author hooks, endpoints, UI extensions |
| [`@lumibase/mcp-server`](https://www.npmjs.com/package/@lumibase/mcp-server) | Stdio MCP server for AI assistants |

## License

Apache-2.0 — part of the [LumiBase](https://github.com/khuepm/lumibase) monorepo.
