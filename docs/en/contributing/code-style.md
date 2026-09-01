---
version: 3
lastUpdated: 2026-09-01T19:24:40.180Z
sourceLang: en
contentHash: 7d1601ecafc706d6
codeVerified: 2026-09-01T19:24:40.180Z
codeVerifiedHash: 7d1601ecafc706d6
codeVerifiedClaims: 4
---

# Code Style Guide

LumiBase follows consistent coding conventions across the monorepo. This guide documents the key rules enforced by our linter and formatter.

## Tools

| Tool | Config | Purpose |
|------|--------|---------|
| TypeScript | `tsconfig.base.json` | Type checking, strict mode |
| ESLint | `.eslintrc.js` (per package) | Linting |
| Prettier | `.prettierrc` | Formatting |
| Husky + lint-staged | `.husky/` | Pre-commit enforcement |

## TypeScript conventions

### Strict mode

All packages use `"strict": true` in TypeScript config. This includes:
- `strictNullChecks`
- `noImplicitAny`
- `strictFunctionTypes`

### Type imports

Always use `import type` for type-only imports:

```typescript
// ✓ Good
import type { Collection } from '@lumibase/contracts'

// ✗ Bad — imports value at runtime
import { Collection } from '@lumibase/contracts'
```

### No `any`

Avoid `any`. Use `unknown` for truly dynamic values and narrow with type guards:

```typescript
// ✓ Good
function parseItem(value: unknown): Item {
  if (!isItem(value)) throw new Error('Invalid item')
  return value
}

// ✗ Bad
function parseItem(value: any): Item { ... }
```

### Zod for runtime validation

All API request/response shapes are validated with Zod. Define schemas in `packages/contracts/src/schemas/`:

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

| Entity | Convention | Example |
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

Keep route handlers thin — delegate to services:

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

Services receive the Hono context `c` (or specific deps) and return typed results:

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

Return the error envelope directly from the handler, with the HTTP status:

```typescript
if (!row) {
  return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Collection not found.' }] }, 404)
}
```

The shape is `{ errors: [{ code, message }] }` — see the response-format rule in
`CLAUDE.md`. Use a stable, machine-readable `code`; the `message` is for humans and
may change.

`app.onError` in `apps/cms/src/index.ts` is the last-resort handler: it catches
anything that throws, logs it with the `requestId`, and returns a generic
`INTERNAL` envelope. Rely on it for unexpected failures, not for expected ones —
an expected outcome should be an explicit `c.json(..., status)` so the status and
code are visible at the call site.

### Multi-tenancy

**Always** scope database queries to `site_id`:

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

Use the `scopeSite(siteId)` helper for common patterns:

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

- Use **TanStack Query** for server state (data fetching, mutations)
- Use **React state** (`useState`, `useReducer`) for local UI state
- Avoid global state stores for server data

### API calls from Studio

Always go through the typed client from `apps/studio/src/lib/api.ts`, which resolves
the base URL, active site and bearer token for you:

```typescript
// ✓ Good
import { getApiClient } from '@/lib/api'
const items = (await getApiClient().items.list('articles', { limit: 10 })).data

// ✗ Bad — raw fetch bypasses base-URL resolution, the site header and auth
const res = await fetch('/api/v1/items/articles')
```
