---
version: 1
lastUpdated: 2026-07-08T20:22:56.199Z
sourceLang: en
translatedFrom: en
sourceHash: cdcd5dfe1e155963
mtEngine: claude
syncStatus: machine-translated
---

# Testing Guide

LumiBase dùng **Vitest** cho unit và integration test trên toàn monorepo. Hướng dẫn này bao quát các quy ước testing, pattern, và cách viết test tốt cho LumiBase.

## Chạy test

```bash
# Run all tests
pnpm test

# Run tests in a specific package
pnpm -F @lumibase/cms test

# Run in watch mode
pnpm -F @lumibase/cms test --watch

# Run with coverage
pnpm -F @lumibase/cms test --coverage

# Run a specific test file
pnpm -F @lumibase/cms test src/services/__tests__/ai-harness-execute.test.ts
```

## Test types

### Unit tests

Test từng function và class một cách độc lập. Mock mọi external dependency.

Vị trí: `src/**/__tests__/*.test.ts`

```typescript
import { describe, it, expect, vi } from 'vitest'
import { AISecureHarness } from '../ai-harness'
import { mockSkills } from './__mocks__/skills'

describe('AISecureHarness', () => {
  describe('evaluateRisk', () => {
    it('marks schema:write skills as dangerous', () => {
      const harness = new AISecureHarness({ skills: mockSkills })
      const result = harness.evaluateRisk('createCollection')
      expect(result.isDangerous).toBe(true)
    })

    it('marks read-only skills as safe', () => {
      const harness = new AISecureHarness({ skills: mockSkills })
      const result = harness.evaluateRisk('listCollections')
      expect(result.isDangerous).toBe(false)
    })
  })
})
```

### Property-based tests

Với logic phải đúng trên nhiều input, dùng **fast-check** (đã được dùng trong codebase):

```typescript
import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import { evaluateConditions } from '../permission-dsl'

describe('evaluateConditions', () => {
  it('never throws on arbitrary filter input (Property 1)', () => {
    fc.assert(
      fc.property(
        fc.record({ status: fc.string(), author: fc.string() }),  // arbitrary item
        fc.anything(),                                              // arbitrary conditions
        (item, conditions) => {
          // Should return a boolean, never throw
          const result = evaluateConditions(conditions, item)
          expect(typeof result).toBe('boolean')
        }
      ),
      { numRuns: 100 }
    )
  })
})
```

Các property được đặt tên `Property N` trong test file — xem `src/services/__tests__/` để có ví dụ.

### Integration tests

Test route handler với một instance Hono app thật và các service được mock:

```typescript
import { describe, it, expect, beforeAll } from 'vitest'
import { testClient } from 'hono/testing'
import { buildApp } from '../../index'
import { mockRuntime } from './__mocks__/runtime'

describe('POST /api/v1/ai/chat', () => {
  let client: ReturnType<typeof testClient>

  beforeAll(() => {
    const app = buildApp({ runtime: mockRuntime })
    client = testClient(app)
  })

  it('returns executed for safe skills', async () => {
    const res = await client.api.v1.ai.chat.$post({
      json: { message: 'list all collections' },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('executed')
  })

  it('returns pending_approval for dangerous skills', async () => {
    const res = await client.api.v1.ai.chat.$post({
      json: { message: 'delete all articles' },
    })

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.data.status).toBe('pending_approval')
    expect(body.data.approvalId).toBeTruthy()
  })
})
```

### DB-backed integration tests

Một số suite chạy SQL thật đối với một Postgres live (drift→goal transition, fingerprint dedupe, partial unique index, tenant scoping). Chúng tuân theo pattern `DATABASE_URL` dùng chung: khi biến này không được set hoặc database không kết nối được, suite sẽ **tự skip** kèm một cảnh báo để `pnpm test` chỉ chạy local và CI không có database vẫn giữ trạng thái xanh.

```typescript
const TEST_DATABASE_URL = process.env.DATABASE_URL

describe('My DB integration', () => {
  let db: Database
  let canConnect = false

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return
    try {
      db = createDb(TEST_DATABASE_URL)
      await db.execute(sql`SELECT 1`)
      canConnect = true
    } catch {
      canConnect = false
    }
  })

  beforeEach(async () => {
    if (!canConnect) return
    // Reset shared tables; cascade from `sites` clears tenant-scoped rows.
    await db.delete(sites).where(/* this suite's site ids */)
  })

  it.runIf(TEST_DATABASE_URL)('does the thing', async () => {
    if (!canConnect) return
    // …
  })
})
```

Chạy chúng đối với một database local:

```bash
# Start Postgres (override the port if 5432 is taken locally)
POSTGRES_PORT=5433 docker compose -f docker/docker-compose.yml up -d postgres

# Apply all migrations to the fresh database
DATABASE_URL="postgres://lumibase:lumibase_dev@localhost:5433/lumibase" \
  pnpm -F @lumibase/database migrate

# Run the suite with the database wired in
DATABASE_URL="postgres://lumibase:lumibase_dev@localhost:5433/lumibase" \
  pnpm -F @lumibase/cms test
```

> **File parallelism.** Khi `DATABASE_URL` được set, `apps/cms/vitest.config.ts` tự động tắt `fileParallelism`. Các integration suite dùng chung một database và reset các bảng dùng chung trong `beforeEach`, nên chạy song song các file của chúng có thể khiến reset của một file xóa sạch fixture của file khác giữa chừng test. Không có database, các test tự skip và phần còn lại của suite chạy hoàn toàn song song.

## Test conventions

### Test cái gì

| Code | Loại test | Mục tiêu coverage |
|------|-----------|-----------------|
| Business logic (services) | Unit | Mọi branch |
| Permission evaluation | Property-based | ≥100 iterations |
| Route handlers | Integration | Happy path + error cases |
| Schema validation | Unit | Valid + invalid inputs |
| Utility functions | Unit | Mọi edge case |

### KHÔNG test cái gì

- Bản thân Drizzle ORM (tin tưởng thư viện)
- Logto JWT validation (tin tưởng thư viện)
- CSS styles (visual regression test nằm ngoài phạm vi)

### Mocking patterns

**Mock runtime (không phải database):**

```typescript
// ✓ Good — mock at the runtime abstraction layer
const mockCache: CacheProvider = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  invalidateByTag: vi.fn().mockResolvedValue(undefined),
}
```

**Mock external HTTP call:**

```typescript
import { http, HttpResponse } from 'msw'
import { server } from './__mocks__/server'  // MSW server

server.use(
  http.post('https://api.openai.com/v1/chat/completions', () => {
    return HttpResponse.json({ choices: [{ message: { content: 'mocked' } }] })
  })
)
```

### Test file naming

```
src/services/__tests__/ai-harness-execute.test.ts      # Unit tests
src/services/__tests__/ai-harness-risk.property.test.ts  # Property tests
src/routes/__tests__/ai-chat-validation.property.test.ts # Route property tests
src/__tests__/ai-integration.test.ts                   # Integration tests
```

## Coverage thresholds

Mục tiêu theo từng package (được thực thi trong CI):

| Package | Branch | Lines |
|---------|--------|-------|
| `@lumibase/cms` | 80% | 85% |
| `@lumibase/database` | 70% | 80% |
| `@lumibase/ai-skills` | 90% | 90% |
| `@lumibase/contracts` | 85% | 90% |

Xem coverage report:

```bash
pnpm -F @lumibase/cms test --coverage
open apps/cms/coverage/index.html
```

## CI

Test chạy tự động trên mỗi PR và push lên `main`:

```yaml
# .github/workflows/test.yml
- name: Run tests
  run: pnpm test

- name: Check coverage
  run: pnpm -F @lumibase/cms test --coverage --reporter=json
```

PR không thể được merge nếu test fail hoặc coverage tụt xuống dưới ngưỡng.
