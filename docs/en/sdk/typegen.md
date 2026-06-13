# TypeScript TypeGen

> Generate fully-typed TypeScript interfaces from your LumiBase schema.

## Overview

LumiBase can generate a `lumibase-types.ts` file from your live schema, similar to what Directus provides. This gives you autocomplete and type safety for all your collections and fields.

## Setup

### Install the SDK

```bash
pnpm add -D @lumibase/sdk
```

### Generate types

Create a local script that uses the SDK you installed instead of invoking an unscoped `npx` package:

```typescript
// scripts/typegen.ts
import { writeFile } from 'node:fs/promises'
import { generateTypes } from '@lumibase/sdk'
import type { TypegenManifest } from '@lumibase/sdk'

const url = new URL('/api/v1/typegen/schema', process.env.LUMIBASE_URL!)
const response = await fetch(url, {
  headers: {
    authorization: `Bearer ${process.env.LUMIBASE_TOKEN!}`,
    'x-lumi-site': process.env.LUMIBASE_SITE_ID!,
  },
})

if (!response.ok) {
  throw new Error(`Typegen failed: ${response.status} ${response.statusText}`)
}

const manifest = await response.json() as TypegenManifest
const types = generateTypes(manifest)

await writeFile('./src/lumibase-types.ts', types)
```

Then add a package script that runs the local file:

```json
{
  "scripts": {
    "typegen": "tsx scripts/typegen.ts"
  },
  "devDependencies": {
    "@lumibase/sdk": "^0.1.0",
    "tsx": "^4.0.0"
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
import { writeFile } from 'node:fs/promises'
import { generateTypes } from '@lumibase/sdk'
import type { TypegenManifest } from '@lumibase/sdk'

const response = await fetch('https://api.mysite.lumibase.dev/api/v1/typegen/schema', {
  headers: {
    authorization: `Bearer ${process.env.LUMIBASE_API_TOKEN!}`,
    'x-lumi-site': 'site_abc123',
  },
})

if (!response.ok) {
  throw new Error(`Typegen failed: ${response.status} ${response.statusText}`)
}

const manifest = await response.json() as TypegenManifest
const types = generateTypes(manifest)

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
