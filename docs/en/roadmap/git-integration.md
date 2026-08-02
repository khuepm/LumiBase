---
version: 1
lastUpdated: 2026-07-25T08:19:21.699Z
sourceLang: vi
translatedFrom: vi
sourceHash: d8c6f58dbfe3b8c0
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:19:21.699Z
codeVerifiedHash: d8c6f58dbfe3b8c0
codeVerifiedClaims: 6
---

# Git Integration Roadmap (GitHub / GitLab)

> **Scope:** let a production LumiBase instance connect to a GitHub/GitLab repository **per site/tenant** — connect a repo through the UI, follow PRs + CI, display and store logs, create preview environments automatically, and lay the groundwork for Config-as-Code + earned autonomy.
>
> **Full spec:** [`.kiro/specs/git-integration/`](../../../.kiro/specs/git-integration/) — `requirements.md` · `design.md` · `tasks.md` · `setup-impact.md`.

## Goals

1. **Per-tenant repo connection** — a site admin connects one or more repos, authenticating via a **GitHub App / GitLab App** (installation token) or **OAuth / PAT**.
2. **PR dashboard + CI logs** — for each PR/MR: show status, CI results, reviewers, and mergeability; pull and store CI logs for later review; link to the preview page.
3. **Auto-created preview environments** — every PR spawns a temporary (ephemeral) preview site inside LumiBase, cleaned up when the PR closes or merges.
4. **Config-as-Code & earned autonomy** — bidirectional schema/intent sync with the repo; a `git-sync` agent operating at its granted autonomy level (L0–L4), with HITL for dangerous operations.

## v1 scope classification (scope freeze — v1-release-criteria §2)

| Area | Classification | Notes |
|---|---|---|
| Repo connection + auth (App/OAuth/PAT), PR/CI dashboard + log viewer, webhook verify + event log, reverse status check, provenance, notification/incident, GitOps **intents** sync | **in-v1** | Implemented (Phase A–E + GitOps intents), DoD 2b/2c closed, tests green; needs DB-backed verification on staging before tagging. |
| Preview environments (ephemeral site) | **in-v1 (opt-in, off by default)** | `sync_config.preview`; cross-site provisioning needs staging verification. |
| GitOps **schema apply** (collections/fields) through the HITL harness | **post-v1** | Only intents sync today; schema apply is deferred. |
| The `git-sync` agent execution loop; auto-triggering GitOps on merge to `main`; YAML config; a complete notification dispatcher | **post-v1** | Called out under "Follow-up" in the phases below. |

> The public API surface of the in-v1 portion (`/api/v1/integrations/git/*`) is frozen in `docs/en/api/hono-api-spec.md` §12c; breaking changes after the freeze roll into the next major (semver). The Setup Impact Registry already carries a git-integration row (`n/a`).

## Architectural principles

- **Provider abstraction:** one shared `GitProvider` interface, with `GitHubProvider` / `GitLabProvider` adapters. Business logic never depends on a specific provider.
- **Reuse existing infrastructure:** webhook HMAC ([`modules/notifications/webhook-channel.ts`](../../../apps/cms/src/modules/notifications/webhook-channel.ts)), token encryption (`CryptoService` + `encryption_keys`), audit + masking, the intent/reconciler (`content_intents`), autonomy (`AutonomyService`), and CDC's deployment lifecycle for previews.
- **Non-negotiable:** every table has `site_id` + RLS; IDs are `nanoid()`/`uuidv7()`; runtime abstraction; HITL for `schema:write`/delete; responses are `{ data, meta? }` / `{ errors }`.

## Phase breakdown

> Status: ⬜ not started · 🟦 in progress · ✅ done. **MVP = Phase A–D (done).**

### Phase A — Foundation ✅
- Schema `packages/database/src/schema/git-integration.ts` (6 `git_*` tables) + migration + RLS.
- The `GitProvider` interface + GitHub/GitLab adapters + factory.
- Token encryption wiring (`CryptoService`, AAD `{ siteId, integrationId }`).

### Phase B — Connect & auth ✅
- `GitIntegrationService` + CRUD routes at `/api/v1/integrations/git/*`.
- OAuth flow + App connect (installation token refresh) + secret rotation.
- Studio: the **Settings → Integrations / Git** page (modelled on `webhooks-page.tsx`), an Authorize button, and scope display.

### Phase C — Webhook & PR/CI ✅
- Public webhook endpoint `POST /webhook/:provider` + signature verification (GitHub HMAC-SHA256 / GitLab token) + idempotency.
- A `git_webhook_events` log + an async processor updating the PR/CI cache.
- PR dashboard + CI status & log viewer (pull and store logs, highlight errors).

### Phase D — Preview environments ✅
- `PreviewEnvManager`: create an ephemeral site per PR, update it on push, tear it down on close/merge, with `expiresAt` and data isolation.
- Attach `previewUrl` to the PR and (optionally) post a comment/deployment status.

### Phase E — Reverse status check + provenance + notification ✅
- Content/schema validation inside the PR → post `lumibase/content-validation` back to the provider.
- A provenance map of `commit_sha`/`pr_number` ↔ `item_id`/`collection`.
- Notification on CI failure; an `agent_incident` when an anomaly repeats.

### Phase F — GitOps & autonomy ✅ (partial)
- `syncFromRepo`: read `lumibase/intents.json` → `content_intents` (upsert) → drift scan + reconcile (`content_drifts` + `agent_goal`). Route `POST /:id/gitops/sync`.
- The `git-sync` agent role added to `ROLE_LIBRARY` with an L1 autonomy baseline (seeded on connect).
- **Follow-up:** schema (collections/fields) apply through the HITL harness; the `git-sync` agent execution loop; auto-trigger on merge to `main`; YAML config.

## Scenarios built on GitHub/GitLab logs

Beyond the core dashboard + log viewer, these scenarios revolve around Git logs/events:

- **CI run timeline per PR** — build a per-job timeline (queued → in_progress → completed) with durations; highlight the failing lines.
- **Log ingestion + storage** — pull logs down and keep them so they remain reviewable even after the provider has deleted them.
- **Log → audit trail** — every webhook is written to `git_webhook_events` and joined to audit, so you can trace "which PR changed which content".
- **Reverse status check** — LumiBase validates, then posts a check run with a summary back to the provider.
- **Log-driven alerting / anomaly** — repeated CI failures → notifications/incident; reuse `modules/anomaly` for build-time anomalies.
- **Provenance map** — answers "which fields did this commit touch, and who merged it".
- **Agent reads logs to auto-fix** — autonomy L1+: the agent reads a failure log and proposes a fixing PR (HITL-gated).
- **Unified activity feed** — interleave Git logs (PR/commit/CI) with CMS events (publish/agent run) by `site_id`.
- **Webhook replay** — the log keeps the raw payload, so a failed processing run can be replayed idempotently.

## Related

- Setup impact: [`.kiro/specs/git-integration/setup-impact.md`](../../../.kiro/specs/git-integration/setup-impact.md) plus the shared registry in `admin-setup-wizard/setup-impact.md` (#30).
- Definition of Done: [`.kiro/steering/definition-of-done.md`](../../../.kiro/steering/definition-of-done.md).
