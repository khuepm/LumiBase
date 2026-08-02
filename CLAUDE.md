# LumiBase — Claude Code Instructions

> **Quick setup:** Read `docs/en/agent-setup/prompt.md` for full machine-readable instructions.
> **API reference:** `docs/en/api/hono-api-spec.md`
> **DB schema:** `packages/database/src/schema/`

## Project overview

LumiBase is a **Content Operating System (Content OS)** — an Edge-native, AI-native headless CMS with dual deployment (Cloudflare Workers + Docker). It is a Turborepo monorepo. As of v0.5.0, content is operated by governed agents against declarative SLOs (intents), reconciled continuously, with earned autonomy (L0–L4) and full provenance; humans set intent, taste, and accountability.

**Philosophy:** Multi-tenant by default · Edge-first caching · Config-as-Code · Intent-driven & reconciled · Earned autonomy (HITL → veto-window → autopilot) for AI ops

## Quick architecture map

```
apps/cms/src/
  index.ts              ← Hono app entry (CF Workers export)
  serve.ts              ← Node.js server entry (Docker)
  middleware/           ← logger → runtime → cors → tenant → auth → db → rls
  routes/               ← Route handlers (thin, delegate to services)
  services/             ← Business logic (ItemService, AISecureHarness, FlowService…)
  modules/              ← Self-contained features (setup, audit, cdc, anomaly…)

packages/
  database/src/schema/  ← Drizzle table definitions (source of truth)
  shared/src/schemas/   ← Zod validation schemas (shared by CMS + Studio + SDK)
  ai-skills/src/        ← AI Copilot skill registry + definitions
  runtime/src/          ← Runtime abstraction (CF ↔ Docker adapters)
```

## Non-negotiable rules

1. **IDs:** `nanoid()` for domain tables, `uuidv7()` for audit tables. Never `serial`/auto-increment.
2. **Multi-tenancy:** Every domain table needs `site_id`. Every query needs `.where(eq(table.siteId, siteId))`.
3. **Runtime abstraction:** Never import CF bindings in business logic. Use `c.get('runtime').cache` etc.
4. **HITL:** Skills with `schema:write` capability or starting with `delete` → `ai_approvals` table first.
5. **Response format:** `{ data: T, meta?: PaginationMeta }` or `{ errors: [...] }`.
6. **TypeScript:** Strict mode, `import type`, no `any`.
7. **Docs are bilingual:** every user-facing doc change lands in **both** `docs/en/`
   and `docs/vi/`, in the same commit. Never edit one locale only.
8. **Deprecation is opt-in:** `withDeprecation` (`apps/cms/src/middleware/deprecation.ts`) is a reusable RFC 8594 tool. Attach it **only** when explicitly told to deprecate/retire/sunset a specific route — never globally, never on healthy endpoints. Unwired while nothing is retiring is correct.

## Docs i18n — mandatory workflow

Both locales are versioned together and neither may be marked a full match on hash
equality alone. Hash equality only proves the two sides describe the *same source
revision*; it cannot tell you either side is *true*. Two translations can agree
perfectly and be wrong together — both confidently documenting an endpoint deleted
a release ago.

So verification against source code comes **before** any full-match marking:

```bash
pnpm docs:i18n:parity <rel>                         # 1. same document? (structure, code, language)
pnpm docs:i18n:verify <rel>                         # 2. check claims vs source tree
node scripts/docs-i18n/stamp-pair.mjs <rel> <en|vi> --verified   # 3. version + flag both locales
pnpm docs:i18n:detect                               # 4. confirm the pair reads up-to-date
git checkout -- docs/.i18n/last-report.json docs/i18n-sync-log.md   # 5. drop detect artifacts
```

- **You write the translation yourself.** There is no `ANTHROPIC_API_KEY` and no
  machine-translation step in CI — a deliberate decision (`docs/.i18n/TASKS.md` §6).
  `--apply` exits 2 without a key; CI's push job only preserves + version-stamps.
  Nothing translates behind your back, so an untranslated side stays untranslated.
- **Which side is the source** is per-file, in the front matter (`sourceLang`). Some
  docs are VI-source with an EN side that is the translation — edit the source side,
  then re-translate the other, or the pair reads stale. Check before editing.
- `--verified` refuses to write `codeVerified` while any claim is stale, and refuses
  when a doc makes no testable claim at all (`unverifiable`) — "nothing to check" is
  not a pass, that file needs human review and is stamped without the flag.
- `codeVerified` is pinned to `codeVerifiedHash`, so editing the body invalidates the
  assurance instead of carrying it forward.
- Two separate markers, deliberately: `syncStatus`/`sourceHash` answer "same
  revision?"; `codeVerified` answers "claims checked?". A full match needs both.
- `stamp-pair` **refuses** on structural drift (`check-parity`): target still in the
  source language, dropped sections, translated identifiers, broken link targets,
  truncated tail. No reviewer stands after the stamp, so fix the translation —
  `--allow-structure-drift` is for a deliberate divergence and needs a stated reason.

Backlog, priority order and the full delegation brief: `docs/.i18n/TASKS.md`. Do not
add commits to a merged translation PR — branch from `main` and open a new one.

## Common tasks

### Run tests
```bash
pnpm -F @lumibase/cms test
pnpm test           # all packages
```

### Add a migration
```bash
pnpm db:generate    # root scripts; the package itself defines `generate`/`migrate`,
pnpm db:migrate     # so `-F @lumibase/database db:migrate` is not a valid script
```

### Run local dev
```bash
docker compose -f docker/docker-compose.yml up -d
pnpm dev
# CMS: http://localhost:1989 | Studio: http://localhost:2026
```

### Type check
```bash
pnpm typecheck
```

## Definition of Done

Mọi feature trước khi đánh dấu hoàn thành phải qua checklist `.kiro/steering/definition-of-done.md` — đặc biệt mục **Setup impact**: rà soát `.kiro/specs/admin-setup-wizard/setup-impact.md` (Setup Impact Registry) và ghi kết quả vào bảng Registry, kể cả khi kết quả là `n/a`.

Ngoài Setup impact, DoD còn có **§2d Desktop/mobile shell impact**: feature đụng auth/token, API base URL, build/dev của Studio, hoặc thêm endpoint mà SPA gọi phải giữ các contract mà `apps/shell` (Tauri) phụ thuộc — xem bảng "Contracts future work must not break" trong `apps/shell/README.md`. Thay đổi có thể hỏng bản desktop/mobile mà không hỏng bản trình duyệt.

Điều kiện thoát cho một **release major** (v1.0.0 và các major sau) nằm ở `.kiro/steering/v1-release-criteria.md` — checklist ở cấp release, tách khỏi DoD per-feature: security audit, scope freeze, quality gate, upgrade-path test, docs/release mechanics và semver policy. Khi bàn "lên v1/major chưa", đối chiếu file đó thay vì khảo sát lại từ đầu.

## Key docs

- Architecture decisions: `docs/en/architecture/decisions/`
- Full API spec: `docs/en/api/hono-api-spec.md`
- Data model: `docs/en/data-model.md`
- AI skills: `docs/en/ai-skills.md`
- User management & auth realms: `docs/en/security/user-management.md` (ADR-010)
- Contributing: `docs/en/contributing/`
