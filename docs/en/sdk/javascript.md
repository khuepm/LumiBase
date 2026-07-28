---
version: 1
lastUpdated: 2026-07-28T11:42:32.541Z
sourceLang: en
contentHash: f4cef639eade1ebc
codeVerified: 2026-07-28T11:42:32.541Z
codeVerifiedHash: f4cef639eade1ebc
codeVerifiedClaims: 4
---

# LumiBase JavaScript SDK

> **Package:** `@lumibase/sdk`
>
> A composable, typed REST client for LumiBase, plus realtime subscriptions and TypeScript type generation.

## Installation

```bash
npm install @lumibase/sdk
# or
pnpm add @lumibase/sdk
```

## The shape of this SDK

Two things to know before the examples, because they differ from most CMS clients:

1. **The client is a transport, not a façade.** `createLumiClient` gives you
   `rawRequest`, `request`, and `with`. Operations are separate **command**
   functions you pass to `request` — a command is a function that takes the
   client and returns a promise. This keeps the bundle tree-shakeable: you import
   only the commands you use.
2. **There is no `login()`.** The client takes a `token` you already hold. Obtain
   it through your auth flow (Logto, or `dev:<logtoId>` in dev mode) and pass it
   in. The client can silently refresh it if you also supply a `refreshToken`.

A convenience plugin, `legacyRest()`, bundles the whole REST surface into grouped
namespaces if you would rather not import commands individually.

## Quick start

```typescript
import { createLumiClient, readItems } from '@lumibase/sdk'

const client = createLumiClient({
  url: 'https://api.mysite.lumibase.dev',
  siteId: 'site_abc123',
  token: process.env.LUMIBASE_TOKEN!,
})

// Commands are curried: build one, hand it to request().
const articles = await client.request(
  readItems('articles', {
    filter: { status: { _eq: 'published' } },
    sort: ['-created_at'],
    limit: 10,
  }),
)
```

---

## Client configuration

`createLumiClient(opts: LumiClientOptions)` (`packages/sdk/src/client.ts`):

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `url` | `string` | Yes | API base URL, e.g. `https://api.lumibase.dev` |
| `token` | `string` | Yes | Bearer token (Logto access token, or `dev:<logtoId>` in dev mode) |
| `siteId` | `string` | Yes | Active tenant id; sent as `X-Lumi-Site` |
| `fetcher` | `typeof fetch` | No | Override fetch (Node/Workers polyfills); defaults to `globalThis.fetch` |
| `headers` | `Record<string, string>` | No | Extra headers on every request |
| `onUnauthorized` | `() => void` | No | Fires once on a `401`, before the `LumiError` throws — clear the stale token and route to login. With auto-refresh on, it fires only after a refresh attempt also fails |
| `refreshToken` | `string` | No | Rotating refresh token. A `401` then triggers one `POST /api/v1/auth/refresh` and retries the original request once |
| `onTokensRefreshed` | `(tokens) => void` | No | Called after a successful silent refresh with the rotated pair, so the host can persist them — the old refresh token is now revoked |

The returned `LumiClient`:

| Member | Description |
|--------|-------------|
| `rawRequest<T>(path, init?)` | One HTTP call; returns `{ data, meta? }` |
| `request<Output>(command)` | Runs a command function against this client |
| `with(plugin)` | Returns the client extended by a plugin's members |
| `url`, `token`, `siteId`, `fetcher` | The resolved configuration |

Refresh is single-flight: a burst of parallel `401`s triggers one refresh, not one per request.

---

## Grouped namespaces via `legacyRest()`

`legacyRest()` is a plugin. Attach it with `with()` and you get the REST surface
as namespaces — convenient for application code and for Studio:

```typescript
import { createLumiClient, legacyRest } from '@lumibase/sdk'

const client = createLumiClient({ url, siteId, token }).with(legacyRest())

await client.schema.collections.list()
await client.items('articles').list({ limit: 20 })
await client.me.getPreferences()
```

Namespaces exposed: `schema` (`collections`, `fields`, `relations`), `items`,
`roles`, `policies`, `access`, `apiKeys`, `shares`, `me`, `permissions`,
`presets`, `translations`, `tm`, `settings`, `uploads`, `site`, `domains`,
`users`, `teams`, `folders`, `files`, `webhooks`, `activity`, `extensions`,
`deployments`, `realtime`.

---

## Items

### The item envelope

An item is **not** a flat record. Field values live under `data`; workflow and
scheduling columns sit beside it:

```typescript
{ data: { title: 'Hello' }, status: 'draft', sort: 1, publishAt: null, unpublishAt: null }
```

### List

```typescript
const res = await client.items('articles').list({
  fields: ['id', 'title', 'status'],
  filter: { status: { _eq: 'published' } },
  sort: ['-published_at'],
  limit: 20,
  offset: 0,
  status: 'published',
})
```

Supported list params are `fields`, `filter`, `sort`, `limit`, `offset`, and
`status`. Note there is **no** `page` param — paginate with `limit`/`offset` —
and no `aggregate`/`groupBy` on this endpoint. Full-text search is the separate
`search` command.

### Detail

```typescript
const article = await client.items('articles').detail('art_abc123', ['id', 'title', 'content'])
```

### Create

```typescript
const created = await client.items('articles').create({
  data: { title: 'New Article', author: 'usr_abc123' },
  status: 'draft',
})
```

### Update (patch) and replace

```typescript
await client.items('articles').patch('art_abc123', {
  data: { title: 'Updated title' },
  status: 'published',
  publishAt: new Date().toISOString(),
})

// PUT — replaces `data` wholesale
await client.items('articles').replace('art_abc123', { data: { title: 'Only field left' } })
```

### Delete and bulk

```typescript
await client.items('articles').delete('art_abc123')

// op is 'create' | 'update' | 'delete'; see docs/en/features/data-import.md
await client.items('articles').bulk('create', [{ title: 'A' }, { title: 'B' }])
```

### Revisions and pins

```typescript
const revisions = await client.items('articles').listRevisions('art_abc123')
await client.items('articles').revertRevision('art_abc123', revisions.data[0].id)

// Law Zero pins — fields a human edit locked against agent writes
await client.items('articles').listPins('art_abc123')
```

---

## Files

```typescript
await client.files.list()
await client.files.create({ /* file metadata */ })
await client.files.update('fil_abc123', { title: 'My Image' })
await client.files.delete('fil_abc123')
```

Binary upload goes through the `uploads` namespace, which is the presigned flow —
the CMS does not accept a file body on `/files`.

For a transform URL, use the `mediaUrl` command rather than building the query
string yourself.

---

## Agent Harness API

The governance lifecycle used by AI runs and generated app artifacts:

```typescript
import {
  generateAgentApp,
  listAgentRuns,
  publishAgentArtifact,
  rollbackAgentArtifact,
} from '@lumibase/sdk/rest'

const result = await generateAgentApp({
  collections: ['products', 'orders', 'customers'],
  targetApp: 'storefront',
  approvalPolicy: 'before_commit',
  budget: { maxToolCalls: 20 },
})(client)

// result.artifacts contains page_spec, component_spec, seed_data, api_spec
const runs = await listAgentRuns()(client)
const published = await publishAgentArtifact(result.artifacts[0].id)(client)
await rollbackAgentArtifact(published.id, 'revert generated storefront')(client)
```

Publishing is idempotent. Schema and migration artifacts require a passing evaluation unless the caller supplies an override reason.

Other agent commands: `createAgentGoal`, `listAgentGoals`, `retryAgentRun`,
`listAgentTools`, `listAgentApprovals`, `decideAgentApproval`,
`createAgentArtifact`, `listAgentArtifacts`, `evaluateAgentArtifact`,
`readAgentMemoryContext`, `writeAgentMemory`.

---

## Change Feed

```typescript
import { readCdcEvents, ackCdcSubscription } from '@lumibase/sdk'

let cursor: string | undefined
for (;;) {
  const { data, meta } = await client.request(readCdcEvents({ collections: ['posts'], cursor }))
  for (const event of data) await handle(event) // dedupe on event.id
  cursor = (meta as { nextCursor?: string }).nextCursor ?? cursor
  if (!(meta as { hasMore?: boolean }).hasMore) break
}
await client.request(ackCdcSubscription(subId, cursor!))
```

See [Change Feed](../features/cdc-change-feed.md) for the delivery semantics.

---

## Realtime

Realtime is a `RealtimeClient`, created through the `realtime` namespace with a token for the WebSocket handshake:

```typescript
const rt = client.realtime.create(process.env.LUMIBASE_TOKEN!, {
  userId: 'usr_abc123',
  initialBackoffMs: 500,
  maxBackoffMs: 30_000,
})
```

`RealtimeClient` and `AudienceClient` are also exported directly from
`@lumibase/sdk` if you want to construct one without the plugin.

---

## TypeScript types

The client is generic over your schema, so generated types flow into every call:

```typescript
import { createLumiClient } from '@lumibase/sdk'
import type { Collections } from './lumibase-types'

const client = createLumiClient<Collections>({ url, siteId, token })
```

See the [TypeGen reference](./typegen.md) for how to generate `lumibase-types.ts`.

---

## Error handling

Every non-2xx response throws `LumiError`:

```typescript
import { LumiError } from '@lumibase/sdk'

try {
  await client.items('articles').create({ data: { title: '' } })
} catch (error) {
  if (error instanceof LumiError) {
    console.error(error.status)            // 400
    console.error(error.body.errors[0].code)    // 'VALIDATION_FAILED'
    console.error(error.body.errors[0].message) // 'title is required'
    console.error(error.body.errors[0].path)    // optional field path
  }
}
```

A non-JSON or bodyless failure is still normalized into the same envelope, with
code `HTTP_ERROR`.
