---
version: 3
lastUpdated: 2026-09-01T19:25:55.158Z
sourceLang: en
contentHash: 859fe974c6e95bce
codeVerified: 2026-09-01T19:25:55.158Z
codeVerifiedHash: 859fe974c6e95bce
codeVerifiedClaims: 7
---

# Testing Guide

LumiBase uses **Vitest** for unit and integration tests across the monorepo. This guide covers testing conventions, patterns, and how to write good tests for LumiBase.

## Running tests

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

Test individual functions and classes in isolation. Mock all external dependencies.

Location: `src/**/__tests__/*.test.ts`

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

For logic that must hold across many inputs, use **fast-check** (already used in the codebase):

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

Properties are named `Property N` in the test file — see `src/services/__tests__/` for examples.

### Integration tests

Test route handlers with a real Hono app instance and mocked services:

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

Some suites exercise real SQL against a live Postgres (drift→goal transitions, fingerprint dedupe, partial unique indexes, tenant scoping). They follow the shared `DATABASE_URL` pattern: when the variable is unset or the database is unreachable, the suite **self-skips** with a warning so local-only `pnpm test` and CI without a database stay green.

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

Run them against a local database:

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

> **File parallelism.** When `DATABASE_URL` is set, `apps/cms/vitest.config.ts` disables `fileParallelism` automatically. Integration suites share one database and reset shared tables in `beforeEach`, so running their files concurrently lets one file's reset wipe another's fixtures mid-test. Without a database the tests self-skip and the rest of the suite runs fully parallel.

## Test conventions

### What to test

| Code | Test type | Coverage target |
|------|-----------|-----------------|
| Business logic (services) | Unit | All branches |
| Permission evaluation | Property-based | ≥100 iterations |
| Route handlers | Integration | Happy path + error cases |
| Schema validation | Unit | Valid + invalid inputs |
| Utility functions | Unit | All edge cases |

### What NOT to test

- Drizzle ORM itself (trust the library)
- Logto JWT validation (trust the library)
- CSS styles (visual regression tests are out of scope)

### Mocking patterns

**Mock the runtime (not the database):**

```typescript
// ✓ Good — mock at the runtime abstraction layer
const mockCache: CacheProvider = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  invalidateByTag: vi.fn().mockResolvedValue(undefined),
}
```

**Mock external HTTP calls:**

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

Per-package targets (enforced in CI):

| Package | Branch | Lines |
|---------|--------|-------|
| `@lumibase/cms` | 80% | 85% |
| `@lumibase/database` | 70% | 80% |
| `@lumibase/ai-skills` | 90% | 90% |
| `@lumibase/contracts` | 85% | 90% |

View coverage report:

```bash
pnpm -F @lumibase/cms test --coverage
open apps/cms/coverage/index.html
```

## CI

Tests run automatically on every PR and push to `main`:

```yaml
# .github/workflows/test.yml
- name: Run tests
  run: pnpm test

- name: Check coverage
  run: pnpm -F @lumibase/cms test --coverage --reporter=json
```

PRs cannot be merged if tests fail or coverage drops below thresholds.

## k6 performance tests

Load scripts live in `apps/cms/k6/`. They use [Grafana k6](https://k6.io/) and are gated in CI via `.github/workflows/perf-k6.yml`.

### Local workflow

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

Baseline numbers are stored under `.kiro/specs/high-load-cache-readiness/baseline/` as JSON (config + p50/p95/p99 + custom metrics). Re-run after meaningful cache or infra changes and commit a new dated file — do not edit old baselines in place.

### Changing thresholds

Thresholds are defined in each script's `export const options.thresholds` block (e.g. `load-deliver.js`). Change them only when:

1. You have a new baseline JSON proving the old bar is unrealistic, or
2. An intentional perf regression is accepted and recorded in the roadmap §2 table.

For CI, keep thresholds at or below **baseline × 1.2** (design §13.3). After raising a threshold, update the corresponding baseline notes file and mention the change in the PR.

The `perf-k6` workflow uploads `load-deliver-summary.json` as an artifact on full runs. The `validate-scripts` job always runs `k6 inspect` so broken scripts fail fast without Docker.

