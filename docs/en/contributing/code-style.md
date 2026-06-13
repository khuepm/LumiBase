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
import type { Collection } from '@lumibase/shared'

// ✗ Bad — imports value at runtime
import { Collection } from '@lumibase/shared'
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

All API request/response shapes are validated with Zod. Define schemas in `packages/shared/src/schemas/`:

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

Use the `AppError` class from `packages/shared`:

```typescript
import { AppError } from '@lumibase/shared'

throw new AppError('RECORD_NOT_FOUND', `Collection '${name}' not found`, 404)
```

The global error handler in `apps/cms/src/middleware/error.ts` converts `AppError` to the standard JSON error envelope.

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

Always use the typed API client from `apps/studio/src/lib/api-client.ts`:

```typescript
// ✓ Good
import { apiClient } from '@/lib/api-client'
const items = await apiClient.items('articles').readMany({ limit: 10 })

// ✗ Bad — raw fetch bypasses auth/error handling
const res = await fetch('/api/v1/items/articles')
```
