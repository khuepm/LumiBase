# TypeScript TypeGen

> Generate fully-typed TypeScript interfaces from your LumiBase schema.

## Overview

LumiBase can generate a `lumibase-types.ts` file from your live schema, similar to what Directus provides. This gives you autocomplete and type safety for all your collections and fields.

## Setup

### Install the SDK

```bash
pnpm add -D @lumibase/sdk
```

### Run typegen

```bash
npx lumibase typegen \
  --url https://api.mysite.lumibase.dev \
  --site-id site_abc123 \
  --token $LUMIBASE_API_TOKEN \
  --output ./src/lumibase-types.ts
```

Or add to `package.json`:

```json
{
  "scripts": {
    "typegen": "lumibase typegen --url $LUMIBASE_URL --site-id $LUMIBASE_SITE_ID --token $LUMIBASE_TOKEN --output ./src/lumibase-types.ts"
  }
}
```

### Generated output

```typescript
// lumibase-types.ts (auto-generated, do not edit)

export interface Collections {
  articles: Article
  products: Product
  users: DirectusUser
  files: DirectusFile
}

export interface Article {
  id: string
  title: string
  content: string | null
  status: 'draft' | 'published' | 'archived'
  author: string | DirectusUser   // relation (ID or expanded)
  tags: string[]
  published_at: string | null
  created_at: string
  updated_at: string
}

export interface Product {
  id: string
  name: string
  price: number
  sku: string | null
  category: string | Category     // many-to-one
  images: string[] | DirectusFile[] // many-to-many
}
```

### Use with the SDK

```typescript
import { createClient } from '@lumibase/sdk'
import type { Collections } from './lumibase-types'

const lumibase = createClient<Collections>({ url: '...', siteId: '...' })

// Fully typed responses
const article = await lumibase.items('articles').readOne('art_abc123')
article.title         // string ✓
article.nonexistent   // TypeScript error ✓

// Filter keys are typed
const articles = await lumibase.items('articles').readMany({
  filter: {
    status: { _eq: 'published' },  // 'draft' | 'published' | 'archived' ✓
  }
})
```

## API-based typegen (programmatic)

```typescript
import { generateTypes } from '@lumibase/sdk'

const types = await generateTypes({
  url: 'https://api.mysite.lumibase.dev',
  siteId: 'site_abc123',
  token: process.env.LUMIBASE_API_TOKEN,
})

await writeFile('./src/lumibase-types.ts', types)
```

## CI integration

Add typegen to your CI pipeline to catch breaking schema changes:

```yaml
# .github/workflows/typegen.yml
- name: Regenerate LumiBase types
  run: pnpm typegen

- name: Check for type drift
  run: git diff --exit-code src/lumibase-types.ts
```

If the schema changes without updating the types file, CI fails and alerts the team.

## Options reference

| Flag | Default | Description |
|------|---------|-------------|
| `--url` | — | CMS API base URL (required) |
| `--site-id` | — | Site identifier (required) |
| `--token` | — | Static API token (required) |
| `--output` | `./lumibase-types.ts` | Output file path |
| `--system` | `false` | Include system collections (files, users, etc.) |
| `--sdk-types` | `true` | Import base types from `@lumibase/sdk` |
