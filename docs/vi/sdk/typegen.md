---
version: 1
lastUpdated: 2026-07-28T11:30:17.385Z
sourceLang: en
translatedFrom: en
sourceHash: e95bb0d2807f2a97
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T11:30:17.385Z
codeVerifiedHash: e95bb0d2807f2a97
codeVerifiedClaims: 4
---

# TypeScript TypeGen

> Sinh các interface TypeScript có type đầy đủ từ schema LumiBase của bạn.

## Tổng quan

LumiBase có thể sinh một file `lumibase-types.ts` từ schema đang chạy của bạn, tương tự như Directus cung cấp. Việc này cho bạn autocomplete và an toàn kiểu cho mọi collection và field.

## Thiết lập

### Cài SDK

```bash
pnpm add -D @lumibase/sdk
```

### Sinh type

Hãy tạo một script cục bộ dùng SDK bạn vừa cài, thay vì gọi một package `npx` không có scope:

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

Rồi thêm một package script chạy file cục bộ đó:

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

### Output được sinh ra

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
  author: string | DirectusUser   // relation (ID hoặc đã expand)
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

### Dùng cùng SDK

```typescript
import { createClient } from '@lumibase/sdk'
import type { Collections } from './lumibase-types'

const lumibase = createClient<Collections>({ url: '...', siteId: '...' })

// Response có type đầy đủ
const article = await lumibase.items('articles').readOne('art_abc123')
article.title         // string ✓
article.nonexistent   // lỗi TypeScript ✓

// Các key filter cũng có type
const articles = await lumibase.items('articles').readMany({
  filter: {
    status: { _eq: 'published' },  // 'draft' | 'published' | 'archived' ✓
  }
})
```

## Typegen qua API (programmatic)

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

## Tích hợp CI

Thêm typegen vào CI pipeline để bắt các thay đổi schema gây phá vỡ:

```yaml
# .github/workflows/typegen.yml
- name: Regenerate LumiBase types
  run: pnpm typegen

- name: Check for type drift
  run: git diff --exit-code src/lumibase-types.ts
```

Nếu schema đổi mà file type không được cập nhật, CI fail và báo cho cả nhóm.

## Tham chiếu options

**Không có typegen CLI** — `@lumibase/sdk` không ship `bin` nào, và đó chính là lý
do phần thiết lập ở trên viết một script cục bộ. `generateTypes(manifest, options)`
nhận manifest do `GET /api/v1/typegen/schema` trả về, cộng một object
`GenerateOptions` (`packages/sdk/src/typegen/index.ts`):

| Option | Type | Mặc định | Mô tả |
|--------|------|---------|-------------|
| `format` | `'single' \| 'per-collection'` | `'single'` | Một file chứa mọi interface, hoặc một module cho mỗi collection |
| `branded` | `boolean` | `true` | Phát ra kiểu primary-key dạng branded thay vì `string` trơn |

Mọi thứ còn lại — gọi URL nào, site nào, token nào, ghi file ra đâu — là code
thông thường trong script của bạn, nên được cấu hình ở đó chứ không qua flag.
