---
version: 2
lastUpdated: 2026-07-25T08:11:35.404Z
sourceLang: en
translatedFrom: en
sourceHash: d03ce24e459e0232
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:11:35.404Z
codeVerifiedHash: d03ce24e459e0232
codeVerifiedClaims: 4
---

# Code Style Guide

LumiBase tuân theo các quy ước code nhất quán trên toàn monorepo. Hướng dẫn này ghi lại những quy tắc chính được linter và formatter của chúng tôi thực thi.

## Tools

| Tool | Config | Mục đích |
|------|--------|---------|
| TypeScript | `tsconfig.base.json` | Type checking, strict mode |
| ESLint | `.eslintrc.js` (per package) | Linting |
| Prettier | `.prettierrc` | Formatting |
| Husky + lint-staged | `.husky/` | Thực thi pre-commit |

## TypeScript conventions

### Strict mode

Mọi package dùng `"strict": true` trong TypeScript config. Điều này bao gồm:
- `strictNullChecks`
- `noImplicitAny`
- `strictFunctionTypes`

### Type imports

Luôn dùng `import type` cho các import chỉ chứa type:

```typescript
// ✓ Good
import type { Collection } from '@lumibase/shared'

// ✗ Bad — imports value at runtime
import { Collection } from '@lumibase/shared'
```

### Không dùng `any`

Tránh `any`. Dùng `unknown` cho các giá trị thực sự động và narrow lại bằng type guards:

```typescript
// ✓ Good
function parseItem(value: unknown): Item {
  if (!isItem(value)) throw new Error('Invalid item')
  return value
}

// ✗ Bad
function parseItem(value: any): Item { ... }
```

### Zod cho runtime validation

Mọi shape của API request/response đều được validate bằng Zod. Định nghĩa schema trong `packages/shared/src/schemas/`:

```typescript
import { z } from 'zod'

export const CreateCollectionSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  displayName: z.string().optional(),
  singleton: z.boolean().default(false),
})

export type CreateCollectionInput = z.infer<typeof CreateCollectionSchema>
```

### Naming conventions

| Entity | Quy ước | Ví dụ |
|--------|-----------|---------|
| Variables | camelCase | `siteId`, `collectionName` |
| Functions | camelCase | `getItems()`, `createCollection()` |
| Classes | PascalCase | `AISecureHarness`, `FlowService` |
| Types/Interfaces | PascalCase | `PermissionRule`, `RuntimeContext` |
| Constants | UPPER_SNAKE | `MAX_PAGE_SIZE`, `DEFAULT_LIMIT` |
| Files | kebab-case | `flow-service.ts`, `ai-harness.ts` |
| Database columns | snake_case | `site_id`, `created_at`, `display_name` |

## Backend conventions (apps/cms)

### Route handlers

Giữ route handler mỏng — delegate cho service:

```typescript
// ✓ Good — handler delegates immediately
app.get('/items/:collection', async (c) => {
  const { collection } = c.req.param()
  const query = parseQuery(c.req.query())
  const items = await itemService.listItems(c, collection, query)
  return c.json({ data: items.data, meta: items.meta })
})

// ✗ Bad — business logic in handler
app.get('/items/:collection', async (c) => {
  const db = c.get('db')
  const items = await db.select().from(collectionsTable).where(...)
  // ...20 more lines of query building
})
```

### Service pattern

Service nhận Hono context `c` (hoặc các dependency cụ thể) và trả về kết quả có kiểu:

```typescript
export class ItemService {
  async listItems(
    c: HonoContext,
    collection: string,
    query: ListQuery
  ): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> {
    const db = c.get('db')
    const siteId = c.get('siteId')
    // ...
  }
}
```

### Error handling

Trả envelope lỗi trực tiếp từ handler, kèm HTTP status:

```typescript
if (!row) {
  return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Collection not found.' }] }, 404)
}
```

Shape là `{ errors: [{ code, message }] }` — xem quy tắc response format trong
`CLAUDE.md`. Dùng `code` ổn định, máy đọc được; `message` dành cho người và có thể
thay đổi.

`app.onError` trong `apps/cms/src/index.ts` là handler cuối cùng: nó bắt mọi thứ
throw ra, log kèm `requestId` và trả envelope `INTERNAL` chung. Chỉ dựa vào nó cho lỗi
ngoài dự kiến, không dùng cho lỗi đã lường trước — trường hợp đã lường trước nên là
một `c.json(..., status)` tường minh để status và code nhìn thấy được ngay tại chỗ gọi.

### Multi-tenancy

**Luôn luôn** scope các database query theo `site_id`:

```typescript
// ✓ Good
const collections = await db
  .select()
  .from(collectionsTable)
  .where(
    and(
      eq(collectionsTable.siteId, siteId),
      eq(collectionsTable.status, 'active')
    )
  )

// ✗ Bad — missing site_id scope
const collections = await db.select().from(collectionsTable)
```

Dùng helper `scopeSite(siteId)` cho các pattern phổ biến:

```typescript
import { scopeSite } from '@lumibase/database'

const items = await db.select().from(table).where(scopeSite(siteId))
```

## Frontend conventions (apps/studio)

### Component structure

```
ComponentName/
  ComponentName.tsx      # Main component
  ComponentName.test.tsx # Tests
  index.ts               # Re-export
```

### State management

- Dùng **TanStack Query** cho server state (data fetching, mutations)
- Dùng **React state** (`useState`, `useReducer`) cho local UI state
- Tránh dùng global state store cho server data

### API calls từ Studio

Luôn đi qua typed client từ `apps/studio/src/lib/api.ts` — nó tự resolve base URL,
site đang active và bearer token cho bạn:

```typescript
// ✓ Good
import { getApiClient } from '@/lib/api'
const items = (await getApiClient().items.list('articles', { limit: 10 })).data

// ✗ Bad — raw fetch bỏ qua base-URL resolution, site header và auth
const res = await fetch('/api/v1/items/articles')
```
