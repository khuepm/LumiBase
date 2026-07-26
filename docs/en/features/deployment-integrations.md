---
version: 1
lastUpdated: 2026-06-29T15:52:20.000Z
sourceLang: en
syncStatus: source
---

# Deployment Integrations (Vercel / Netlify)

> Trigger, monitor, and debug deployments on external hosting providers (**Vercel**, **Netlify**, or a generic **HTTP** deploy hook) directly inside LumiBase — no jumping to the provider dashboard.

Tables: `deployment_targets`, `deployments` (`packages/database/src/schema/deployments.ts`) · Service: `apps/cms/src/services/deployment/` · Mounted at `/api/v1/deployments`.

## 1. Goal & model

Each **deployment target** configures one connection to one project on one provider, scoped to a site. From that target you trigger builds and watch their status without leaving Studio.

- **Trigger** — kick off a build/deploy manually, or automatically when content changes.
- **Monitor** — track status (`queued → building → ready/error`) in near real time.
- **Debug** — view build logs, error messages, branch/commit, and a link to the provider deployment.

One target = one `(site, provider, project)`. One **deployment** = one build/deploy run on that target, with a LumiBase-normalized status and log excerpt.

- **Edge-native:** provider adapters use only `fetch` (REST) — they run on both Cloudflare Workers and Docker through the shared runtime.
- **Multi-tenant:** every `deployment_targets` / `deployments` row carries `site_id`, and every query is scoped by it.

## 2. Providers

| Provider | `provider` | Trigger | Status |
|---|---|---|---|
| Vercel | `vercel` | Deploy Hook / REST `POST /deployments` | Polled + inbound webhook |
| Netlify | `netlify` | Build Hook / REST | Polled + inbound webhook |
| Generic HTTP | `http` | Any deploy-hook URL (`POST`) | Polled where the endpoint exposes status |

Adapters live in `apps/cms/src/services/deployment/providers/`. Each provider maps its own states onto the normalized `status` enum: `queued | building | ready | error | canceled`.

## 3. Token security

Provider API tokens are **never stored in plaintext**. On create, the token is encrypted via the runtime **KeyProvider** (ADR-002) and stored as `token_ciphertext` + `token_key_id`. It is decrypted only at call time to talk to the provider, and is **never returned** by the API — the `DeploymentTargetResource` returned to clients omits the token entirely.

## 4. Status sync

Two complementary paths keep a deployment's status current:

- **Status poller** — a 30s cron (`apps/cms/src/services/deployment/status-poller.ts`, registered in `serve.ts`) sweeps every non-terminal deployment and syncs it from the provider. Each sync is a guarded conditional update (only flips `queued`/`building`) and a single provider error never aborts the sweep — re-running is a no-op.
- **Inbound webhook** — `POST /api/v1/deployments/webhook/:provider` (public, pre-auth) receives provider-pushed status events. It is intentionally outside the authenticated surface because the provider authenticates by **signing the request body**, not a bearer token; it still runs `withTenant` + `withDb`. The signature is verified for real over the raw body via Web Crypto: **Vercel** uses HMAC-SHA1 (`x-vercel-signature`), **Netlify** a JWS/HS256 (`x-webhook-signature`), compared in constant time. The shared secret is read from the per-site setting `deployment.webhook.<provider>` (value `{ "secret": "…" }`) — **never** from a request header. If no secret is configured, every webhook request is rejected (`401 INVALID_SIGNATURE`); status still syncs via the poller.

## 5. REST API

All routes are under `/api/v1/deployments`, on the authenticated + tenant-scoped surface (`withAuth`).

| Method & path | Purpose |
|---|---|
| `GET /targets` | List configured targets (token omitted) |
| `POST /targets` | Create a target (token encrypted on write) |
| `PATCH /targets/:id` | Update a target |
| `DELETE /targets/:id` | Delete a target |
| `POST /targets/:id/deploy` | Trigger a build/deploy |
| `GET /` | List deployments (filter by `targetId` / `status`) |
| `GET /:id` | Get one deployment |
| `GET /:id/logs` | Fetch build logs |
| `POST /:id/refresh` | Force a status sync from the provider |

SDK (`@lumibase/sdk`): `client.deployments.targets.{list,create,update,delete,deploy}` and `client.deployments.{list,get,logs,refresh}`, typed with `DeploymentTargetResource` / `DeploymentResource`.

## 6. Auto-deploy via Flows

The "deploy automatically when content changes" path is wired through the Flows engine, not a bespoke trigger. Two operations are registered on the flow runtime (`apps/cms/src/services/flow-service.ts`):

| Operation | Options | Effect |
|---|---|---|
| `deploy:trigger` | `targetId` (required), `branch?`, `reason?` | Triggers a deploy via the shared `DeploymentService` (same path, guards and audit as the manual API). Records `triggerSource='auto'` and links the flow `runId` for provenance. |
| `deploy:status` | `deploymentId` (required) | Syncs and returns one deployment's status so a flow can branch on it. |

Wire an auto-deploy by creating a Flow with `triggerType: 'event'` (e.g. an item publish in a collection) whose graph contains a `deploy:trigger` node pointing at a target. Both operations are runtime-bound: `db`, `siteId`, the **KeyProvider** (`keys`) and `runId` are supplied by the flow run environment (`routes/flows.ts`), so a deploy launched from a flow reuses the encrypted token and SSRF/audit guards exactly like the manual trigger. Missing environment or a missing `targetId`/`deploymentId` fails closed with a clear error before any provider call.

## 7. AI skills & HITL

Four governed skills let the AI Copilot operate deployments (`packages/ai-skills/src/skills.ts`, handlers in `ai-harness.ts`):

| Skill | Capability | Risk |
|---|---|---|
| `listDeploymentTargets` / `listDeployments` / `getDeploymentStatus` | `deployments:read` | safe |
| `triggerDeployment` | `deployments:write` | **dangerous** → HITL `before_execute` below autopilot |

`triggerDeployment` triggers an outward-facing side effect (a build on an external host), so it is classified dangerous: below autopilot autonomy it is routed through human approval (`ai_approvals`) instead of executing directly.

## 8. Studio

A **Settings → Deployments** page (`apps/studio/src/modules/settings/deployments-page.tsx`) lists targets and recent deployments, with controls to add a target, trigger a deploy, refresh status, and view logs. It lives at `/settings/deployments` (and `/<adminPath>/settings/deployments` on instances with a custom admin path), reachable from the **Integrations** group of the settings sidebar.

## 9. Setup notes

- **Capabilities:** adds `deployments:read` / `deployments:write` — grant them to the admin role on upgrade. (No default agent role carries `deployments:write`, so the `triggerDeployment` skill only runs for callers explicitly granted it — deploy is never auto-available to ordinary agents.)
- **No seed:** targets are created by an admin after setup; there are no defaults.
- **RLS:** `lumibase_deployment_targets` and `lumibase_deployments` are site-isolated via `packages/database/migrations/rls-policies.sql` (per project convention, not in the table migration).
- **Inbound webhooks (optional):** to receive provider-pushed status, set the per-site setting `deployment.webhook.<provider>` to `{ "secret": "<shared secret>" }` and configure the same secret on the provider's webhook. Without it, status syncs via the 30s poller only.
- **Tables** `lumibase_deployment_targets` and `lumibase_deployments` are part of the consolidated `0000_lumibase_init` schema migration.
- See the spec under `.kiro/specs/deployment-integrations/` for the full requirements and design.
