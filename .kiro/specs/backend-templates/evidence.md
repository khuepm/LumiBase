# Backend templates — acceptance evidence (BT09)

Acceptance matrix for epic #900, keyed to the `BTxx-ACyy` IDs in
`work-items/`. Each row names the test that carries the evidence. A row that is
**blocked** or **pending** says so. A skipped DB test never counts as a pass.

## Run (BT09-AC01)

| | |
|---|---|
| Recorded | 2026-11-19 |
| Runtime | Node v22.23.4, pnpm 9.12.0, PostgreSQL 16.15 (real server, not a mock) |
| DB | `lumibase_e900`, migrated through `0046` with `packages/database/migrations/rls-policies.sql` |
| Storage / runtime supported | `jsonb` storage only; transactional runtime (Docker/Node with PostgreSQL). A runtime without `db.transaction` is refused (`INCOMPATIBLE_RUNTIME`) |

Commands (`DATABASE_URL` points at the DB above):

```bash
pnpm -F @lumibase/contracts exec vitest run src/backend-templates            # 94 passed
pnpm -F @lumibase/cms exec vitest run src/services/backend-templates \
  src/routes/__tests__/backend-templates-mcp.db.integration.test.ts         # 50 passed, 0 skipped
pnpm -F @lumibase/studio exec vitest run src/modules/data-model/templates   # 7 passed
pnpm -F @lumibase/cms exec vitest run                                         # 7153 passed, 1 failed*
```

\* `src/__tests__/golden-path.e2e.test.ts` fails locally because there is no
Redis (login 500). It fails the same way on the epic base, and runs in CI as
its own "E2E golden path" job. Not caused by this epic.

Commits per ticket (stacked PRs into `epic/900-backend-templates`):

| Ticket | PR | Commit |
|---|---|---|
| BT01 #901 | #959 (merged) | `c8e28f38` |
| BT02 #902 | #962 (merged) | `9784d378` |
| BT03 #903 | #964 (merged) | `4709058b` |
| BT04 #904 | #965 (merged) | `0c16036f` |
| BT05 #905 | #966 | `992f745f` |
| BT07 #907 | #968 | `c2e2432f` |
| BT06 #906 | #979 | `fb83f36f` |
| BT08 #908 | #981 | `7e1fda2f` |
| BT09 #909 | this PR | see PR |

## Matrix

Test files, abbreviated below:
`contract` = `packages/contracts/src/backend-templates/__tests__/backend-template-contract.test.ts`,
`plan.test` = `…/__tests__/plan.test.ts`,
`catalog` / `planner` / `installer` / `seed` / `wordpress` / `isolation` =
`apps/cms/src/services/backend-templates/__tests__/<name>.db.integration.test.ts`
(`isolation` = `tenant-isolation`), `mcp` =
`apps/cms/src/routes/__tests__/backend-templates-mcp.db.integration.test.ts`,
`studio` = `apps/studio/src/modules/data-model/templates/__tests__/templates-page.test.tsx`.

| AC | Status | Evidence |
|---|---|---|
| BT01 (contract, all ACs) | pass | `contract`: round-trip and permutation properties, digest changes, duplicate keys with path, cycles, every limit (2 MiB, depth 32, 100/2000/500/1000, 1 MiB seed), export without runtime identity |
| BT02-AC01…AC06 | pass | `catalog` (AC04 also under real RLS with a NOSUPERUSER NOBYPASSRLS role) |
| BT03-AC01…AC06 | pass | `planner`, `plan.test` |
| BT04-AC01…AC07 | pass | `installer` (atomic rollback by fault injection, 10 concurrent requests → 1 install, idempotency, stale/revoked, crash after commit, commit effects) |
| BT05-AC01…AC07 | pass | `seed` |
| BT06-AC01…AC07 | pass | `mcp` (real middleware chain → `/mcp` → AISecureHarness → `/agent/approvals/:id/decide`) |
| BT07-AC01, AC04, AC05, AC06 | pass | `wordpress` |
| BT07-AC02 | **partial** | Relations resolve and expand (`wordpress`). "Invalid targets are rejected" is **blocked**: the item API does not check that an m2o target exists (backlog B241) |
| BT07-AC03 | **partial** | Required fields, choices and nullable refs pass. "Duplicate unique slug fails" is **blocked**: `unique` is not enforced on JSONB collections (B240). Defaults are not applied by the item API (B242) |
| BT08-AC01…AC06 | pass (jsdom) | `studio`: every request is recorded (site header, body, idempotency key). A real-browser E2E against a live CMS is **pending** |
| BT09-AC01 | pass | this file |
| BT09-AC02 | pass | `isolation`: two admins each install `wordpress-alike` + demo **through the RLS app role**; neither scope reads, finds or writes the other's templates, revisions, plans, installations, collections, fields, relations or items; unscoped sees nothing |
| BT09-AC03 | pass | `mcp` BT06-AC02 (author → publish), BT06-AC03 (agent install, no seed), BT09-AC03 (agent demo install, then MCP `createItem` under normal permissions; member refused); `studio` (Studio install); `seed` BT05-AC06 (later population) |
| BT09-AC04 | pass | rollback `installer` AC01; duplicate/concurrent `installer` AC03; stale/replayed approval `mcp` AC04–AC05; unsupported runtime `planner` AC06 and `installer`; namespace conflict `planner` AC03 |
| BT09-AC05 | pass | Migration rehearsal below |
| BT09-AC06 | pass | `docs/{en,vi}/tutorials/backend-template-blog.md` and `docs/{en,vi}/features/backend-templates.md`. Both are stamped `--verified` (code references checked). The `wordpress-alike` compatibility range is a real range (`>=2.1.0 <3.0.0`), not a placeholder |
| BT09-AC07 | **pending sign-off** | Checklist below. Every BT01–BT08 AC has evidence, except the blocked parts of BT07-AC02/AC03 and the real-browser part of BT08 |
| BT10 | **future** | Not implemented and not a v1 blocker. Installations record a `baseline` for a future upgrade planner |

## Migration rehearsal (BT09-AC05)

Run on 2026-11-19 against PostgreSQL 16.15:

1. **Fresh DB, migrated twice.**
   - Create `lumibase_e909_fresh`, then run `pnpm db:migrate` and `rls-policies.sql` twice.
   - Result: 47 applied migrations, the 4 `lumibase_backend_template*` tables, and 8 RLS policies on them.
   - The second run applies nothing.
2. **Existing configured instance upgraded.**
   - Migrate `lumibase_e909_up` to the pre-epic head (`MIGRATE_TARGET=0043_release_manifest pnpm db:migrate`), which gives 44 migrations and no template tables.
   - Add a site with a collection and a published item.
   - Hash all collections, fields, items and relations, then migrate to head.
   - Result: the hash is identical before and after (`90f52c5c599ecb125a186f18066bbd03`), and there are 0 templates, plans and installations.
   - The re-run reports "Nothing to apply: the schema is already current."
3. **Backfill:** none needed. The tables are new, and no existing row is rewritten.
4. **Numbering:** migrations `0044`–`0046` are numbered after the epic base. They will be renumbered when the epic lands on `main`.

## Release gate (BT09-AC07)

- [x] Contract, catalog, planner, installer, seed, official template, MCP, Studio and tenant suites pass (above).
- [x] `pnpm typecheck`, `pnpm check:all` (registry, docs nav, logical CSS, …) and `pnpm test` pass on each ticket branch.
- [x] Setup Impact rows 340–347 are present, with unique ids (`pnpm registry:check`).
- [x] Flags and defaults are documented:
  - REST is admin-only.
  - MCP tools need the existing per-site `contentOs.mcp` flag.
  - Seed is off by default.
  - There is no default target site.
  - No public grants are created.
- [x] BT10 is marked future and not implemented.
- [ ] Reviewer decision on the blocked parts of BT07-AC02/AC03 (B240, B241, B242).
- [ ] Real-browser E2E for the Studio install review (BT08).
- [ ] Reviewer sign-off.
