---
version: 1
lastUpdated: 2026-07-28T00:17:09.977Z
sourceLang: vi
translatedFrom: vi
sourceHash: 0a8252d582be20fa
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-28T00:17:09.977Z
codeVerifiedHash: 0a8252d582be20fa
codeVerifiedClaims: 8
---

# Analysis: applying MCP to the 7 Directus-inspired specs

> Purpose: the place to come back to when deciding **which features should be exposed over MCP**, as what tools, at what risk and priority. Based on the existing MCP infrastructure ([`index.md`](index.md)). The tables/sections below are the **original design analysis**; the **current implementation state** lives in the "MCP roadmap" section (Wave 1/2 + the small patches = shipped). Each entry states its prerequisite (the REST/service must exist first).
>
> Source label: everything below is **[Inference]** based on the architecture as read in the codebase, not on observed runtime behaviour.

## Decision principles (applied to every spec)

1. **MCP comes after REST.** An MCP tool calls through `AISecureHarness`/a skill, or calls REST internally — the feature's REST/service must exist first. So MCP for these 7 features is **phase 2**, after the original spec is implemented.
2. **The permission floor is invariant.** An MCP tool never exceeds the token's rights. A tool that mutates the schema or is named `delete*` automatically gets `risk = dangerous` → goes through `agent_approvals` (HITL). Good for safety, but it means write tools carry approval latency.
3. **Criteria for "worth putting on MCP":** a task that is (a) repetitive/automatable, (b) something an agent/LLM benefits from being able to call, (c) more read than write (reads are safe, writes need guards). Purely-UI tasks (drag-and-drop, pickers) do **not** belong on MCP.
4. **Two ways to add a tool:** (A) add it to `packages/mcp-server` (stdio, editor) — fast, CRUD-style; (B) register a skill in the harness + `agentTools` → it appears in the HTTP `tools/list` automatically — the right path for tools with risk/approval/autonomy.

---

## MCP priority summary

| Spec | MCP value | MCP priority | Direction | Risk note |
|---|---|---|---|---|
| content-versioning | High | **P1** | B (harness skill) | promote = dangerous → HITL |
| insights-dashboard | High (read) | **P1** | A + B | run-panel is read-only and safe; query injection already blocked in the service |
| visual-flow-builder | Medium-high | **P2** | B | triggering a flow is a side effect; needs its own capability |
| translation-memory-ui | High | **P1** | A | lookup/translate are read-mostly, ideal for an agent |
| image-transform-dsl | Low | **P3** | A (get URL only) | transform is delivery, low agent value |
| realtime-subscriptions | Low/n.a. | **P3** | — | MCP is request/response, not streaming; a poor fit |
| presets-inheritance | Low | **P3** | A | a small convenience; mostly UI state |

---

## 1. content-versioning → **P1**

**Why:** a content agent benefits a lot from creating version branches, comparing them, and promoting — this is the "draft → review → publish" loop agents already run through revisions.

**Proposed tools (direction B — a harness skill, because it writes + needs HITL):**
- `version.list(collection, itemId)` — read, `safe`.
- `version.create(collection, itemId, key, name)` — write, `review_required`.
- `version.compare(collection, itemId, key)` — read, `safe`, returns `Change[]`.
- `version.promote(collection, itemId, key)` — **`dangerous`** (applies to main) → `agent_approvals` (matches the existing HITL; promote already goes through `ItemService.update`).

**Prerequisite:** the `content-versioning` spec (service + routes + SDK) finished.
**Risk:** promote overwrites main; HITL is mandatory, plus the `mainDiverged` warning. Keep the autonomy cap at ≤ L2 for `version.promote`.

## 2. insights-dashboard → **P1 (read-only)**

**Why:** "ask about the numbers" is the classic MCP use case — an agent/LLM queries an aggregate to answer an operational question without a human opening a dashboard.

**Proposed tools (A for reads, via internal REST):**
- `dashboard.list()`, `dashboard.getPanels(id)` — read.
- `panel.run(dashboardId, panelId, { dateRange?, filter? })` — read, returns `PanelResult`. **Safe**, because the service already whitelists fields, blocks injection, and filters by siteId.
- (Optional) `insights.query({ collection, aggregate, field, groupBy, filter })` — an ad-hoc aggregate reusing `panelQuerySchema` → answers questions without a pre-saved panel. **This is the highest-value MCP tool across all 7 features** (an agent asking the data itself).

**Prerequisite:** `insights-service.ts` + `panelQuerySchema` (shared) finished.
**Risk:** low (read). Still apply collection permissions and a limit cap so it cannot pull huge amounts of data.

## 3. visual-flow-builder → **P2**

**Why:** an agent can trigger automation in context (run a flow), or read run history to diagnose.

**Proposed tools (B — because triggering has side effects):**
- `flow.list()`, `flow.getRuns(id)`, `flow.getRun(id, runId)` — read, `safe`.
- `flow.run(id, input)` — write/side effect, `review_required` or `dangerous` depending on the flow (a flow can do http/mail/item mutation). Needs its own `flow:trigger` capability.

**Prerequisite:** the flow-gap spec (run history endpoint + trigger) finished.
**Risk:** a flow can cause external side effects (http/mail) → triggering over MCP must carry a narrow capability + low autonomy; consider forbidding `flow.run` for low-capability tokens.

## 4. translation-memory-ui → **P1**

**Why:** translation is an LLM-native task; an agent calling TM lookup/translate is a natural flow. Read-mostly, low risk.

**Proposed tools (A — the REST already exists):**
- `tm.lookup({ sourceLang, targetLang, text, threshold? })` — read, `safe`.
- `tm.translate({ ... })` — the TM→glossary→MT pipeline; `safe` (or `review_required` if it calls a paid MT).
- `tm.upsert({ ... })` — write, `review_required` (it writes into the TM store).
- `tm.list/update/delete` — management, at the usual risk levels.

**Prerequisite:** only the current TM backend (already there!) plus the PATCH/DELETE endpoints from the `translation-memory-ui` spec. ⇒ **MCP for TM can ship earliest** because the backend is already sufficient.
**Risk:** low; `tm.translate` may incur MT cost → rate-limit it.

## 5. image-transform-dsl → **P3**

**Why:** transform is delivery (an image to a browser); an agent gains little. The MCP value is mainly **getting a transform URL** to embed in content.

**Proposed tools (A, small):**
- `media.url(key, { preset | dsl })` — returns the signed URL (if signing is on). Read, `safe`.
- `transformPreset.list()` — read.

**Prerequisite:** the `image-transform-dsl` spec finished.
**Risk:** low; do not expose transform compute over MCP (it would be pointless).

## 6. realtime-subscriptions → **P3 / a poor fit**

**Why:** the MCP HTTP endpoint is **one-shot request/response**, with no server-initiated stream (SSE is off). Realtime/subscriptions **do not map** onto that model.

**Conclusion:** **do not put subscriptions on MCP.** If an agent needs to "know an item just changed", use a **polling** tool `items.listSince(collection, since)` (read) rather than subscribing. Recorded here so the effort is not wasted.
**Future:** revisit if the MCP spec/implementation gains stable streaming notifications.

## 7. presets-inheritance → **P3**

**Why:** a preset is UI view state; low agent value. It could help an agent "open a collection in the role's standard view".

**Proposed tools (A, optional):**
- `preset.effective(collection)` — read, returns the default view. `safe`.

**Prerequisite:** the `presets-inheritance` spec finished.
**Risk:** low.

---

## Proposed MCP roadmap (after the original specs are implemented)

1. **Wave 1 (high value, low risk, read-first): ✅ shipped**
   - `insights.query` / `panel.run` (read aggregate — the highest-value MCP tool) → `packages/mcp-server/src/tools/insights.ts` (`query_insights`, `run_panel`, `list_dashboards`, `get_dashboard`, `list_dashboard_panels`).
   - `tm.lookup` / `tm.translate` (already present beforehand — `lookup_tm`, `translate_text`).
2. **Wave 2 (guarded writes): ✅ shipped (`version.*`)**
   - `version.*` via **direction B (harness skill)** — not a stdio passthrough — so `promoteVersion` goes through HITL/autonomy. Skills: `listVersions`, `compareVersion` (safe); `createVersion`, `updateVersion`, `deleteVersion`, `promoteVersion` (dangerous). Defined in `apps/cms/src/services/ai-harness.ts` + `packages/ai-skills/src/skills.ts`; exposed via `POST /api/v1/mcp` (`tools/list`).
   - `tm.upsert` — already there (`upsert_tm`).
3. **Wave 3 (side effects, proceed carefully):**
   - `flow.run` (narrow capability + low autonomy) — `run_flow` exists today as a stdio passthrough; a governed version (the `runFlow` harness skill, dangerous) also exists. Adds `get_flow_run` (read one run in detail, for diagnosis).
4. **Small completing patches: ✅ shipped** (stdio passthrough, safe read/CRUD):
   - TM: `update_tm` (PATCH `/tm/:id`), `delete_tm` (DELETE, `confirm=true`).
   - Flow: `get_flow_run` (GET `/flows/:id/runs/:runId`).
   - Image transform: `list_transform_presets` (GET `/transform-presets`). **`media.url` is deliberately NOT exposed** — the signed delivery URL is built at the edge with a server secret (`transformKey`/HMAC), and no REST endpoint returns a signed URL; `/files/presigned-url` is upload-only. Putting it on MCP would either return a wrong URL (no signature) or require duplicating the secret — neither is acceptable.
   - Presets: `get_effective_preset` (GET `/presets/effective`), `list_preset_bookmarks` (GET `/presets/bookmarks`).
5. **Skip / watch:** realtime (a poor fit for request/response — use `cdc_events_read` to poll rather than subscribe).

**Conclusion:** all 7 Directus-inspired specs are now covered at the MCP level exactly as analysed, plus governed versioning. Beyond those 7, a sweep of every `/api/v1/*` route added the content-ops surfaces that had not previously reached MCP: **editorial** (`list_reviews`/`submit_review`/`approve_content`/`reject_content`), **releases** (CRUD + `publish_release`), **deployments** (read-only; triggering stays governed), **shares** (`create_share`/`revoke_share`), and `get_site`. The only remaining MCP gaps are the **deliberate exclusions** — see the "Deliberately NOT on MCP" table in [`index.md`](index.md) (realtime streaming, signed media URLs, binary up/download, triggering a deploy, security/GDPR admin, auth/self-service, dev/infra tooling).

> **Why does `version.*` take direction B rather than a stdio passthrough?** `promoteVersion` overwrites main; principle #2 (permission floor + HITL for dangerous writes) requires it to flow through `AISecureHarness` so it reaches `agent_approvals`. The stdio server (`@lumibase/mcp-server`) is a passthrough with no HITL, so it only suits safe read/CRUD — not promote. Versioning is therefore **deliberately absent** from the stdio server; it appears only on the governed endpoint. See [`index.md`](index.md) §Content versions.

## Common preconditions before opening any write tool on MCP

- A write tool → the correct `riskPolicy.level` (`review_required`/`dangerous`) so it reaches `agent_approvals`.
- Set a `rateLimit` for tools that call an LLM/MT or are resource-hungry (`tm.translate`, a heavy `insights.query`).
- Parity test: add a case to `mcp-parity.property.test.ts` proving the MCP decision == the harness decision.
- Update the tool table in [`index.md`](index.md) when a new tool appears in `tools/list`.
