---
<!-- check-parity: allow inline-code -->
version: 4
lastUpdated: 2026-09-08T21:00:34.356Z
sourceLang: en
translatedFrom: en
sourceHash: 4575c3d9c04845cc
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-09-10T19:51:39.334Z
codeVerifiedHash: 4575c3d9c04845cc
codeVerifiedClaims: 10
---

<!-- check-parity: allow inline-code -->

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

Một số suite chạy SQL thật đối với một Postgres live (drift→goal transition, fingerprint dedupe, partial unique index, tenant scoping). Chúng dùng chung một harness, `apps/cms/src/__tests__/helpers/db-harness.ts`, và harness này phân biệt được điều mà pattern `canConnect` cũ không phân biệt nổi:

| Tình huống | Kết quả | Vì sao |
|---|---|---|
| `DATABASE_URL` vắng | **skipped** | Không ai yêu cầu chạy test DB. |
| `DATABASE_URL` có nhưng không kết nối được | **failed** | Có người yêu cầu test DB và đã không nhận được. |

Dòng thứ hai mới là điểm chính. Convention trước đây chặn mọi hook và test bằng `if (!canConnect) return`, mà **một early return là một test PASS** — nên một lần chạy đối với database không tồn tại vẫn báo `20 passed / 76 passed / exit 0`, không cách nào phân biệt với một lần chạy thật. Hãy viết suite như sau:

```typescript
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness'

describe.skipIf(!hasDbIntegrationUrl)('My DB integration', () => {
  let db: Database

  beforeAll(async () => {
    // Throws if the database does not answer — the suite fails, never skips.
    db = await connectDbIntegration('my-suite')
  })

  afterAll(async () => {
    if (!db) return // beforeAll may have thrown
    // …cleanup
  })

  beforeEach(async () => {
    // Reset shared tables; cascade from `sites` clears tenant-scoped rows.
    await db.delete(sites).where(/* this suite's site ids */)
  })

  it('does the thing', async () => {
    // No connection guard: reaching here means the database answered.
  })
})
```

Từ đó có hai quy tắc:

- Đặt `describe.skipIf(!hasDbIntegrationUrl)` ở describe **cấp cao nhất**, để vitest in ra một `skipped` thật thay vì đếm những assertion chưa từng chạy.
- Không dùng `if (!canConnect) return` ở bất cứ đâu. Một tripwire quét source (`db-integration-guard.wiring.test.ts`) làm đỏ build khi thấy shape cũ, và khi thấy bất kỳ `*.db.integration.test.ts` nào không import harness — một suite chỉ có thể *quên* harness, mà không test hành vi nào quan sát được việc đó.

Một `describe` cấp cao nhất không có gate chỉ được phép khi nó không chạm tới database (ví dụ một helper thuần nằm cạnh suite); tripwire assert đúng điều này.

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

> **Một `DATABASE_URL` cũ nay sẽ fail.** Nếu shell của bạn đang export `DATABASE_URL` trỏ tới một database không còn chạy, các suite DB sẽ **đỏ** thay vì xanh một cách im lặng. Đó là chủ ý — đúng cái failure mà harness này ra đời để loại bỏ. Bỏ biến đó đi để skip suite DB, hoặc bật database lên.

> **File parallelism.** Khi `DATABASE_URL` được set, `apps/cms/vitest.config.ts` tự động tắt `fileParallelism`. Các integration suite dùng chung một database và reset các bảng dùng chung trong `beforeEach`, nên chạy song song các file của chúng có thể khiến reset của một file xóa sạch fixture của file khác giữa chừng test. Không có database, các test được skip và phần còn lại của suite chạy hoàn toàn song song.

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

## Kiểm thử hiệu năng k6

Các script tải nằm trong `apps/cms/k6/`. Chúng dùng [Grafana k6](https://k6.io/) và được kiểm tra trong CI qua `.github/workflows/perf-k6.yml`.

### Quy trình chạy local

```bash
# 1. Start dependencies
docker compose -f docker/docker-compose.yml up -d postgres redis

# 2. Migrate + seed (CI uses SEED_ITEMS=1000 per collection; full baseline = 100000)
DATABASE_URL=postgres://lumibase:lumibase_dev@localhost:5432/lumibase \
  pnpm -F @lumibase/database migrate
SEED_ITEMS=1000 DATABASE_URL=postgres://lumibase:lumibase_dev@localhost:5432/lumibase \
  pnpm exec tsx apps/cms/k6/seed.ts

# 3. Start CMS
DATABASE_URL=postgres://lumibase:lumibase_dev@localhost:5432/lumibase \
  REDIS_URL=redis://localhost:6379 \
  JWT_SECRET=local-dev \
  pnpm -F @lumibase/cms exec tsx src/serve.ts

# 4. Run scripts (install k6: https://k6.io/docs/get-started/installation/)
k6 run --env BASE_URL=http://localhost:1989 apps/cms/k6/smoke.js
k6 run --env BASE_URL=http://localhost:1989 \
     --env SITE_ID=site_load_a \
     --env COLLECTION=articles \
     apps/cms/k6/load-deliver.js
```

Số liệu baseline được lưu dưới `.kiro/specs/high-load-cache-readiness/baseline/` dưới dạng JSON (config + p50/p95/p99 + các metric tùy chỉnh). Chạy lại sau những thay đổi đáng kể về cache hoặc hạ tầng và commit một file mới có ngày — không sửa trực tiếp baseline cũ.

### Thay đổi ngưỡng

Ngưỡng được định nghĩa trong khối `export const options.thresholds` của từng script (ví dụ `load-deliver.js`). Chỉ thay đổi khi:

1. Có baseline JSON mới chứng minh ngưỡng cũ không thực tế, hoặc
2. Một suy giảm hiệu năng có chủ ý đã được chấp thuận và ghi trong bảng roadmap §2.

Trong CI, giữ ngưỡng không vượt quá **baseline × 1.2** (design §13.3). Sau khi tăng ngưỡng, cập nhật file ghi chú baseline tương ứng và nêu thay đổi trong PR.

Workflow `perf-k6` tải lên `load-deliver-summary.json` làm artifact khi chạy đầy đủ. Job `validate-scripts` luôn chạy `k6 inspect` để script hỏng bị phát hiện sớm mà không cần Docker.
