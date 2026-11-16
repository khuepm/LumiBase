# v1.0.0 Security Review (`v0.18.0` → `HEAD` `83d82262`)

- **Criterion:** `.kiro/steering/v1-release-criteria.md` §1c — Re-run `/security-review` over the cumulative diff from `v0.18.0` to the release candidate (`83d82262`, after `v1.0.0-rc.4`).
- **Date:** 2026-11-08
- **Scope:** 901 commits across `apps/cms`, `apps/studio`, `apps/shell`, `packages/database`, `packages/contracts`, `packages/runtime`, `packages/mcp-server`, `packages/sdk`, and `.github/workflows`.

---

## 1. Methodology & Surface Coverage

The review audited five attack surfaces introduced or modified between `v0.18.0` and `HEAD`:

1. **Middleware & Authentication Pipeline (`apps/cms/src/index.ts`, `middleware/*`)**
   - Ordering and invariants of `withTenant` → `withDb` → `withTenantExists` → `withAiIpRateLimit` → `withAuth` → `withSiteMembership` → `withRateLimit` → `requireSetupComplete` → `withStudioAccess` → `withControlPlaneAccessGuard` → `withFileUploadPolicy` → `withRls`.
   - Public pre-auth mounts (`/api/v1/setup`, `/api/v1/admin/security/{recover,forgot-path}`, `/scim/v2`, `/api/v1/deployments/webhook`, `/api/v1/integrations/git/{oauth,webhook}`, `/api/v1/shares`, `/api/v1/email/unsubscribe`, `/api/v1/deliver`, `/api/v1/pageviews/:site_id/hit`) verified for disjoint leaf paths, signature/token verification before state mutation, and per-route rate limiting.
2. **Route-Level Authorization & Realm Separation (`apps/cms/src/routes/*`, `modules/*`)**
   - Every router mounted on `/api/v1` checked against `CONTROL_PLANE_PATHS`, `STUDIO_ACCESS_PATH_PREFIXES`, `requireSiteAdmin()`, `PermissionService`, and `itemServiceForRequest(c)`.
   - Verification of the three realms (`public` anonymous, `frontend` subscriber, `studio` staff) plus `lbk_pub_` publishable vs secret API keys.
3. **Database Migrations & Multi-Tenant Isolation (`packages/database/drizzle/0001..0023`, `migrations/rls-policies.sql`)**
   - Idempotency, `CHECK` constraints (`0012_public_role_least_privilege`), RLS permissive + restrictive policy pairs on 48 tenant tables (`B125`/`B130`), and RBAC role→policy backfill collision resistance (`deriveLegacyRoleKey` with role ID suffix).
4. **Marketplace, Extensions & Outbound Fetch (`routes/marketplace.ts`, `extensions/sandbox.ts`, `services/ssrf-guard.ts`)**
   - Re-verification of the 2026-07-16 finding on `POST /api/v1/marketplace/publish` (`#212`).
5. **AI Copilot, Agent Harness, RAG, Decisions & MCP (`#577`: `#578`–`#585`)**
   - Cross-checked with the 8 completed workstream audit reports (`docs/review-agent/2026-11-01-ai-audit-578..584*.md` and `#585` evaluation gates).

---

## 2. Previously Flagged Pre-v1 Findings — Verified Closed

| Item | Location | Status at `83d82262` | Evidence |
|---|---|---|---|
| **Marketplace `/publish` missing authorization & signature check** (flagged in `#212` 2026-07-16 review) | `apps/cms/src/routes/marketplace.ts:638-734` | **Fixed** | Gated by `requireConfigurePermission(c)`, requires `target.submissionStatus === 'approved'` for community submissions (`409 NOT_APPROVED`), verifies Ed25519/RSA-PSS signature against stored `bundleUrl` via `ExtensionVerifierService.verifyByMetadata`, and enforces official signature on reserved `lumibase-*` namespace. |
| **RBAC backfill key-normalization privilege escalation** | `packages/database/src/backfill/role-policies.ts` | **Fixed** | `deriveLegacyRoleKey` suffixes the stable role `id` so colliding normalized names never share a policy (`upgrade-path.e2e.test.ts` §3b). |
| **Forged `X-Lumi-Site` audit FK crash / batch drop (`#469`)** | `middleware/tenant-exists.ts`, `modules/audit/worker.ts` | **Fixed** | 4-layer defence: `withTenantExists` before `withAuth` (`404 TENANT_NOT_FOUND`), cross-tenant API key denial logged under key's own `siteId`, fulfilled flush tail, and `AuditLogBatcher.insertWithSalvage` (`audit-batch-isolation.db.integration.test.ts`). |
| **AI Agent / RAG / MCP security & reliability (`#577`: `#578`–`#585`)** | `services/ai-harness.ts`, `agent-run-worker.ts`, `permission-service.ts`, `llm-provider.ts` | **Fixed** | Impact-aware write risk (`#586`), owner-bound Copilot conversations + isolated system instructions (`#587`), principal-bound queued agent runs (`#595`, `#602`), sample stripping & embedding validation (`#596`), context window budgets & grounded citation checks (`#597`, `#603`), principal-scoped permission cache & 20s upstream deadlines (`#598`, `#604`), atomic approval parking & `side_effect_uncertain` replay prevention (`#599`, `#601`), tool contract parity gates (`#600`). |
| **GitHub Actions `pages-deploy.yml` token permissions & Shell `rustls` advisory** | `.github/workflows/pages-deploy.yml`, `apps/shell/src-tauri/Cargo.lock` | **Fixed (`#605`)** | Workflow token downgraded to `contents: read`; `rustls` bumped `0.23.41 → 0.23.46`. |

---

## 3. Findings Discovered & Fixed in This Review

### S1 (High — CWE-284 / CWE-862): `/api/v1/domains` and `PATCH /api/v1/site` lacked admin authorization

- **Affected code:**
  - `apps/cms/src/routes/domains.ts` (`GET/POST /api/v1/domains`, `POST /api/v1/domains/:id/{verify,primary}`, `DELETE /api/v1/domains/:id`)
  - `apps/cms/src/routes/site.ts` (`PATCH /api/v1/site`)
  - `apps/cms/src/middleware/control-plane-access-guard.ts` (`CONTROL_PLANE_PATHS`)
- **Description:** `domainsRouter` provisions custom hostnames, mutates `lumibase_site_domains`, and writes/deletes host→site KV routing mappings (`putHostMapping` / `deleteHostMapping`). `PATCH /api/v1/site` mutates tenant configuration (`name`, `domain`, `siteUrl`, `customCss`, `branding`, `themeOverrides`). Neither route enforced `requireSiteAdmin()`, and `/api/v1/domains` was absent from `CONTROL_PLANE_PATHS` and `STUDIO_ACCESS_PATH_PREFIXES`. Any authenticated site member, `frontend`-audience subscriber session, or site API key (including a publishable `lbk_pub_` key) could mutate tenant branding/CSS or add/delete custom domain mappings for its site.
- **Fix (in this branch):**
  - Added `domainsRouter.use('*', requireSiteAdmin())` in `apps/cms/src/routes/domains.ts`.
  - Added `'/api/v1/domains'` to `CONTROL_PLANE_PATHS` (`control-plane-access-guard.ts`) and `STUDIO_ACCESS_PATH_PREFIXES` (`studio-access.ts`).
  - Added `requireSiteAdmin()` to `siteRouter.patch('/', requireSiteAdmin(), ...)` in `apps/cms/src/routes/site.ts` (keeping `GET /api/v1/site` readable for authenticated members and MCP `ops` tools).
  - Added behavioural and tripwire assertions in `apps/cms/src/routes/__tests__/site.test.ts` and `apps/cms/src/__tests__/security-guards.wiring.test.ts`.

### S2 (Medium — CWE-284 / ADR-011 Realm Separation): `/api/v1/pages` omitted from `STUDIO_ACCESS_PATH_PREFIXES`

- **Affected code:** `apps/cms/src/middleware/studio-access.ts` (`STUDIO_ACCESS_PATH_PREFIXES`), `apps/cms/src/routes/pages.ts`
- **Description:** `routes/pages.ts` documents `/api/v1/pages` as `Studio-authenticated (inherits api middleware)` and performs CRUD over `lumibase_pages` (which backs the public `/api/v1/deliver/:slug` endpoint). Because `/api/v1/pages` was not listed in `STUDIO_ACCESS_PATH_PREFIXES`, `withStudioAccess()` only ran when the client voluntarily sent `X-Lumi-Client: studio`. A `frontend`-audience subscriber session or a publishable API key (`lbk_pub_…`) could therefore call `POST/PATCH/DELETE /api/v1/pages` directly.
- **Fix (in this branch):**
  - Added `'/api/v1/pages'` to `STUDIO_ACCESS_PATH_PREFIXES` in `apps/cms/src/middleware/studio-access.ts` so `withStudioAccess()` enforces a user principal with `appAccess: true` (and `tfaRequired` when applicable) and blocks `frontend`-audience tokens and API keys.
  - Pinned in `apps/cms/src/__tests__/security-guards.wiring.test.ts`.

---

## 4. Residual / Accepted Items (Non-Blocking for `v1.0.0`)

- **CWE-359 (PII in audit metadata):** Accepted for v1.0 with redact-on-write policy (`docs/en/security/cwe-top-100-audit.md`, owner `khuepm`).
- **Post-v1 fine-grained permission model (`#364`, `B70`):** Studio editor surfaces shared with standalone MCP (`episodes/dashboards/tm/editorial/releases`) authenticate tenant membership and (for `/releases` and `/items`) delegate item mutations to `itemServiceForRequest(c)`. Finer per-module capabilities remain tracked under `#364` / `B70`.
- **Workspace-external example advisories:** `examples/hono-webhook` and `examples/extension-email-setup` are standalone reference folders outside the pnpm workspace; production dependency audit (`pnpm audit --prod --audit-level high`) passes with 0 high/critical vulnerabilities.
