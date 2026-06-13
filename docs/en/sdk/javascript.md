# LumiBase JavaScript SDK

> **Package:** `@lumibase/sdk`
>
> The LumiBase JS SDK provides a typed REST client, WebSocket subscription support, and TypeScript type generation for your collections.

## Installation

```bash
npm install @lumibase/sdk
# or
pnpm add @lumibase/sdk
```

## Quick start

```typescript
import { createClient } from '@lumibase/sdk'

const lumibase = createClient({
  url: 'https://api.mysite.lumibase.dev',
  siteId: 'site_abc123',
})

// Authenticate
await lumibase.auth.login({ email: 'admin@example.com', password: 'password' })

// Read items
const articles = await lumibase.items('articles').readMany({
  filter: { status: { _eq: 'published' } },
  sort: ['-created_at'],
  limit: 10,
})

// Create an item
const newArticle = await lumibase.items('articles').createOne({
  title: 'Hello World',
  status: 'draft',
})
```

---

## Client configuration

```typescript
const lumibase = createClient({
  url: string              // Required: CMS API base URL
  siteId: string           // Required: site identifier
  token?: string           // Optional: static access token (skip auth flow)
  timeout?: number         // Optional: request timeout in ms (default: 30000)
  onTokenRefresh?: (token: string) => void  // Optional: callback on token refresh
})
```

---

## Authentication

### Login with credentials

```typescript
const { access_token, refresh_token, user } = await lumibase.auth.login({
  email: 'admin@example.com',
  password: 'your-password',
})
```

### Refresh token

```typescript
const { access_token } = await lumibase.auth.refresh(refresh_token)
```

### Logout

```typescript
await lumibase.auth.logout()
```

### Get current user

```typescript
const me = await lumibase.auth.me()
// { id, email, firstName, lastName, role, capabilities }
```

### Static token (for server-to-server)

```typescript
const lumibase = createClient({
  url: '...',
  siteId: '...',
  token: process.env.LUMIBASE_API_TOKEN,  // Long-lived token from Settings → API Tokens
})
```

---

## Items API

### Read multiple items

```typescript
const { data, meta } = await lumibase.items('articles').readMany({
  fields: ['id', 'title', 'status', 'author.name'],
  filter: {
    status: { _eq: 'published' },
    _and: [
      { published_at: { _gte: '$NOW(-30 days)' } }
    ]
  },
  sort: ['-published_at'],
  page: 1,
  limit: 20,
  search: 'lumibase',
})
// data: Article[]
// meta: { total, page, pageSize }
```

### Read single item

```typescript
const article = await lumibase.items('articles').readOne('art_abc123', {
  fields: ['id', 'title', 'content', 'author.name', 'tags'],
})
```

### Read singleton

```typescript
const settings = await lumibase.singleton('site_settings').read({
  fields: ['*'],
})
```

### Create item

```typescript
const article = await lumibase.items('articles').createOne({
  title: 'New Article',
  status: 'draft',
  author: 'usr_abc123',
})
```

### Bulk create

```typescript
const articles = await lumibase.items('articles').createMany([
  { title: 'Article 1', status: 'published' },
  { title: 'Article 2', status: 'draft' },
])
```

### Update item

```typescript
const updated = await lumibase.items('articles').updateOne('art_abc123', {
  status: 'published',
  published_at: new Date().toISOString(),
})
```

### Delete item

```typescript
await lumibase.items('articles').deleteOne('art_abc123')
```

### Bulk delete

```typescript
await lumibase.items('articles').deleteMany(['art_abc123', 'art_def456'])
```

### Aggregate

```typescript
const stats = await lumibase.items('articles').readMany({
  aggregate: { count: '*', sum: ['views'] },
  groupBy: ['status'],
})
// [{ status: 'published', count: 42, sum_views: 10000 }, ...]
```

---

## Files API

### Upload a file

```typescript
// Browser: File object
const file = await lumibase.files.upload(fileInput.files[0], {
  title: 'My Image',
  folder: 'fld_images',
})

// Node.js: Buffer or stream
const file = await lumibase.files.upload(buffer, {
  filename: 'image.png',
  type: 'image/png',
  title: 'My Image',
})
```

### Get asset URL with transforms

```typescript
const url = lumibase.files.getAssetUrl('fil_abc123', {
  width: 800,
  height: 600,
  format: 'webp',
  quality: 80,
  fit: 'cover',
})
// Returns: https://api.../assets/fil_abc123?width=800&height=600&format=webp&...
```

---

## Agent Harness API

The SDK exposes the governance lifecycle used by AI runs and generated app artifacts:

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
})(lumibase)

// result.artifacts contains page_spec, component_spec, seed_data, api_spec
const runs = await listAgentRuns()(lumibase)
const published = await publishAgentArtifact(result.artifacts[0].id)(lumibase)
await rollbackAgentArtifact(published.id, 'revert generated storefront')(lumibase)
```

Publishing is idempotent. Schema and migration artifacts require a passing evaluation unless the caller supplies an override reason.

---

## WebSocket / Realtime

```typescript
const ws = lumibase.realtime()

// Subscribe to a collection
const subscription = ws.subscribe('articles', {
  event: '*',  // 'create' | 'update' | 'delete' | '*'
  query: {
    fields: ['id', 'title', 'status'],
    filter: { status: { _eq: 'published' } },
  },
  callback: (event) => {
    console.log(event.event, event.data)  // 'update', { id: '...', title: '...' }
  },
})

// Unsubscribe
subscription.unsubscribe()

// Presence (who's online)
ws.joinRoom('articles/art_abc123')
ws.onPresence((users) => {
  console.log('Active users:', users)
})

// Disconnect
ws.disconnect()
```

---

## TypeScript types

After running typegen, import auto-generated types:

```typescript
import type { Collections } from './lumibase-types'

type Article = Collections['articles']
// { id: string; title: string; status: 'draft' | 'published'; ... }

const article: Article = await lumibase.items('articles').readOne('art_abc123')
```

See [TypeGen reference](./typegen.md) for how to generate types.

---

## Error handling

```typescript
import { LumibaseError } from '@lumibase/sdk'

try {
  await lumibase.items('articles').createOne({ title: '' })
} catch (error) {
  if (error instanceof LumibaseError) {
    console.error(error.code)    // 'VALIDATION_FAILED'
    console.error(error.message) // 'title is required'
    console.error(error.errors)  // [{ code, message, path }]
  }
}
```

---

## SDK for Flows

```typescript
// Trigger a flow
const run = await lumibase.flows.run('flw_abc123', {
  userId: 'usr_xyz',
  action: 'welcome',
})

// Get run status
const runDetail = await lumibase.flows.getRun('flw_abc123', run.runId)
```

---

## SDK for AI Copilot

```typescript
// Send a chat message
const response = await lumibase.ai.chat('Create a collection called "events"')

if (response.status === 'executed') {
  console.log('Done:', response.data)
} else if (response.status === 'pending_approval') {
  console.log('Waiting for approval:', response.approvalId)
}

// List pending approvals
const approvals = await lumibase.ai.listApprovals()

// Approve
await lumibase.ai.decide(approvals[0].id, 'approved')
```
