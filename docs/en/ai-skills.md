---
version: 9
lastUpdated: 2026-11-21T11:15:29.917Z
sourceLang: en
contentHash: b5f6a7299575cec5
codeVerified: 2026-11-21T11:15:29.917Z
codeVerifiedHash: b5f6a7299575cec5
codeVerifiedClaims: 10
---

# AI Skills Documentation for LumiBase Development

This document contains the structured AI prompts and skills used to guide AI-assisted development of LumiBase. Copy these sections into your AI assistant's system prompt or use them as reference when working with AI coding assistants.

---

## 1. Project Blueprint: LumiBase Core Identity

**Objective:** Help AI understand the essence and vision of the project.

* **Project Name:** LumiBase.
* **Philosophy:** "Directus-inspired, Edge-native, Production-ready".
* **Problem Solved:** Overcome Directus weaknesses in Multi-tenancy, ID collision, poor cache management, and CI/CD difficulties.
* **Core Architecture:** Headless CMS supporting dynamic data management combined with UI configuration (Page-builder mindset) returned in a single API call.

---

## 2. Technical Stack Definition (The "Hard" Skills)

**Objective:** Strictly define the technologies AI is allowed to use.

* **Runtime:** Node.js (Edge-compatible, prefer Hono.js or ElysiaJS).
* **Database:** PostgreSQL (Hybrid RDBMS + JSONB).
* **Infrastructure:** Cloudflare Stack (Workers, R2, Hyperdrive, KV).
* **Authentication:** Logto (OIDC, Multi-tenancy).
* **Communications:** Resend (Email), Webhooks (Event-driven).
* **Frontend Reference:** Next.js (App Router, SSR), TailwindCSS, Shadcn UI.

---

## 3. AI Skills / System Prompts

Copy the following sections into your AI assistant's system prompt or project README to ensure AI always follows these guidelines:

### Skill 1: Database & Migration Architect

> **Task:** Design schema and data synchronization mechanisms.
> * **ID Rules:** Absolutely no Serial/Auto-increment. Use NanoID (short, URL-friendly) or UUIDv7.
> * **Multi-tenancy:** Every table must have `site_id` for absolute Row-Level data separation.
> * **Config-as-Code:** Build module to export/import configuration (Roles, Permissions, Collections) to YAML/JSON files to support GitOps.

### Skill 2: Edge & Caching Specialist

> **Task:** Optimize performance on Cloudflare.
> * **Cache Tagging:** Implement cache invalidation by Tag in Redis/Cloudflare KV. When a record updates, invalidate all related cache-keys.
> * **File Security:** Build middleware to check File Signature (Magic Numbers) before upload to Cloudflare R2, do not trust file extensions from client.

### Skill 3: Unified Data Hydration Logic

> **Task:** Handle "1-roundtrip" data flow.
> * **Logic:** Design API `/deliver/{page_slug}` that aggregates Page Config (from `pages` table) and Data (from related `collections`) into a single JSON.
> * **SEO-Ready:** Ensure returned JSON structure has enough information for Next.js SSR to render complete HTML without additional API calls.

### Skill 4: UI/UX Component Bridge

> **Task:** Connect CMS with TailwindCSS/Next.js.
> * **Pattern:** Use Class Variance Authority (CVA) to map CMS "Intents" to actual Tailwind classes.
> * **Rich Content:** Use `html-react-parser` to handle dynamic HTML from CMS, ensuring conversion of `<a>` tags to Next.js `<Link>` and `<img>` tags to Next.js `<Image>`.

---

## 3b. Runtime AI Skill Registry (MCP & Governed Harness)

> These are the **runtime** skills agents can invoke — distinct from the developer prompts above. Source of truth: `apps/cms/src/services/ai-harness.ts` (`buildCoreSkills`) mirrored as metadata in `packages/ai-skills/src/skills.ts`. A registry-sync test asserts the two stay aligned.

Skills run through the **governed endpoint** `POST /api/v1/mcp` (gated by the per-site `contentOs.mcp` flag) via `AISecureHarness.execute`, inheriting every guard: kill switch → capability check → autonomy L0–L4 → veto window → HITL approval → audit.

**Risk classification.** A skill is dangerous (HITL/autonomy-gated) when it (a) sets the `dangerous` flag, (b) requires a mutating `schema:*` capability, or (c) is named `delete*`. Item CRUD stays non-dangerous. Irreversible skills (`deleteCollection`, `deleteField`, `deleteRole`, `deletePolicy`, `deleteRelation`, `revokeApiKey`, `removeUser`) are hard-capped at autonomy **L2** and never run on autopilot.

**Never autonomous (#991).** Skills that extend the system's own privileges or code share the same L2 ceiling and are always treated as dangerous, so they park for a human at every level (or are refused at L0): `installExtension`, `updateExtension`, `uninstallExtension`, `createApiKey`, `rotateApiKey`, `createWebhook`, `updateWebhook`, `createFlow`, `upsertSetting`, `deleteSetting`, `createRole`, `createPolicy`, `inviteUser`, `updateUser` (`NEVER_AUTONOMOUS_SKILLS` in `ai-harness.ts`). Earned autonomy covers content operations, not these.

**Publishing at L4 (#991).** A publication an agent makes on its own — `createItem` with `status: 'published'`, a status change, or a patch on a live item — must also pass the active tenant constitution (its blocking evaluators, run against the resulting content) and stay within the role's hourly publish budget: `budget.maxPublishesPerHour` on the intent, default 30. The budget holds under concurrency: each publish reserves its slot under a per-site, per-role database lock before it runs, so parallel runs on any number of workers cannot exceed it, and a publish that fails gives its slot back. Either failing parks the call for approval with `riskReason` `constitution_blocked` or `publish_budget_exceeded` instead of executing. Agent-authored content that the content-integrity monitor flags records a `content_integrity` incident, which demotes the role (see [Content integrity](./security/content-integrity.md)).

| Skill | Capability | Risk |
|-------|-----------|------|
| `listCollections` / `listItems` | `schema:read` / `items:read` | safe |
| `createCollection` / `createField` | `schema:create` / `schema:update` | dangerous |
| `deleteCollection` / `deleteField` | `schema:delete` | dangerous · irreversible |
| `createItem` / `updateItem` / `deleteItem` | `items:write`/`update`/`delete` | safe (delete via name) |
| `listVersions` / `compareVersion` | `items:read` | safe |
| `createVersion` / `updateVersion` / `deleteVersion` / `promoteVersion` | `items:write` | dangerous — write-guarded; `promoteVersion` applies a branch to main (revision-protected, so not hard-capped like schema drops) |
| `aiSuggestField` · `aiContentAssist` · `generate*` | `schema:read` / `items:*` | safe |
| `listRelations` | `schema:read` | safe |
| `createRelation` / `deleteRelation` | `schema:create` / `schema:delete` | dangerous · (delete) irreversible |
| `planContentMigration` / `applyContentMigrationSchema` | `schema:read` / `schema:create` + `schema:update` | safe / dangerous (approval) — see [Content migration](./features/content-migration.md) |
| `listRoles` / `listPolicies` | `access:read` | safe |
| `createRole` / `createPolicy` | `access:create` | dangerous |
| `deleteRole` / `deletePolicy` | `access:delete` | dangerous · irreversible |
| `listIntents` / `createIntent` / `deleteIntent` | `intents:read` / `intents:write` | safe / dangerous |
| `listFlows` / `createFlow` / `deleteFlow` / `runFlow` | `flows:read` / `flows:write` / `flows:run` | safe / dangerous |
| `listApiKeys` / `createApiKey` / `rotateApiKey` / `revokeApiKey` | `api-keys:read`/`create`/`write`/`delete` | safe / dangerous (`revoke` irreversible) |
| `listUsers` / `inviteUser` / `updateUser` / `removeUser` | `users:read`/`write`/`delete` | safe / dangerous (`remove` irreversible) |
| `listTeams` / `createTeam` / `deleteTeam` / `addTeamMember` / `removeTeamMember` | `teams:read`/`write`/`delete` | safe / dangerous |
| `listSettings`/`listTranslations`/`listWebhooks` + their create/update/delete | `config:read`/`write`/`delete` | safe / dangerous |
| `listExtensions` / `installExtension` / `updateExtension` / `uninstallExtension` | `extensions:read`/`write`/`delete` | safe / dangerous |
| `listDeploymentTargets` / `listDeployments` / `getDeploymentStatus` / `triggerDeployment` | `deployments:read` / `deployments:write` | safe / dangerous (`trigger` gated by HITL below autopilot) |
| `listCdcSubscriptions` / `getCdcSubscriptionStatus` / `createCdcSubscription` / `replayCdcSubscription` / `deleteCdcSubscription` | `cdc:manage` | reads safe; `create`/`replay`/`delete` are control-plane → HITL below autopilot. `create`/`replay` carry an explicit `dangerous` flag, `delete` via the `delete` name prefix — so the agent/MCP path matches the admin-only `/api/v1/cdc` REST surface |
| `askUser` / `getUserAnswer` | `items:read` | safe — `askUser` parks the run in `waiting_user` until a human answers in Mission Control (or it times out / is cancelled); `getUserAnswer` returns the answer to the requester only, as untrusted data. Not on the autonomy gradient: asking is allowed at every level. Not offered to the Copilot chat, which has no run to pause. See [agent harness](features/agent-harness-layer.md#asking-a-human-askuser-710) |
| `describeImage` / `extractFieldsFromPdf` | `items:read` | safe — read-only; the file is read with the caller's `files::read` access. `describeImage` returns alt text, `extractFieldsFromPdf` proposes field values for a new item (creating it is a separate `createItem`). See [Images and PDFs as input](#images-and-pdfs-as-input-709) |
| `proposeSiteSkill` | `config:write` | dangerous — always parks for a human's approval below autopilot; an approved proposal creates a **draft** Site Skill (never active, never overwrites an existing slug), with the agent and its `rationale` on the version trail. See [Site Skills](features/site-skills.md#agent-proposals) |

**Reserved collection names.** `createCollection` (and any rename via `updateCollection`) rejects names starting with the `lumibase_` prefix, which is owned by the platform (CDC/Firebase sync tables, internal config). The guard lives in `SchemaService.ensureName`, so it applies uniformly to the AI harness, the builder/Studio routes, and any other caller; violations raise `RESERVED_NAME` (HTTP 422).

### Images and PDFs as input (#709)

A Copilot turn can carry up to 4 files from the media library. The Studio
assistant has two buttons for this: **Attach** picks from the library, and
**Upload** adds a file from your device to the library first. Over the API, use
`attachments: [{ fileId }]` on `POST /api/v1/ai/chat`. The provider adapters
send each file as the provider's own image or document block (OpenAI
`image_url` / `file`, Anthropic `image` / `document`, Gemini and Vertex
`inlineData`).

- **Types and limits** (`AI_ATTACHMENT_LIMITS` in `apps/cms/src/services/ai-attachments.ts`):
  PNG, JPEG, GIF and WebP images up to 5 MB, PDFs up to 10 MB, 20 MB per turn.
  SVG, HEIC and other types are refused with `415`.
- **Access.** A file is read with the caller's own `files::read` access, the
  same rule (site admin or a folder-scoped grant) that guards downloading it.
  A file outside that scope answers `404`, like one that does not exist.
  Quarantined or not-yet-scanned files are refused with `409`.
- **Untrusted.** Text inside an image or a PDF is data, never instructions. The
  turn opens with a notice that names the files and says so. Whatever the model
  proposes still runs through the harness with the caller's capabilities,
  autonomy level and approvals.
- **Not stored.** The conversation keeps `{ fileId, name, mimeType, size }`,
  never the bytes, and older turns are not re-sent with their files. A turn with
  files always runs synchronously, because file access is checked on that
  request.
- **Providers.** OpenAI, Anthropic, Gemini and Vertex AI are supported (use a
  model that accepts images and PDFs). Workers AI answers
  `422 LLM_ATTACHMENTS_UNSUPPORTED` without calling the model. Files count
  against the context budget by estimate: about 1,600 tokens per image, and at
  least 3,000 per PDF, growing with its size. With the default
  `LLM_CONTEXT_WINDOW_TOKENS` (32,768) about 20,000 tokens are left for the
  conversation and its files once the tool catalogue and output reserve are
  counted. Set it to your model's real window to send large PDFs; a turn that
  does not fit fails with `413 LLM_CONTEXT_LIMIT`.

Two skills read a file by id, from the chat or from `POST /api/v1/mcp`:

- `describeImage { fileId, maxLength?, language? }` returns
  `{ fileId, altText, language }`. The alt text is cut at a word boundary
  within `maxLength` (default 125).
- `extractFieldsFromPdf { fileId, collection, instruction? }` returns
  `{ fileId, collection, data, ignored, notes }`. Only fields a document can
  fill are offered to the model; relations, files, aliases, rich text and
  translations are left out. A value whose JSON type does not fit its field is
  dropped and listed in `ignored`. Nothing is written. Creating the item is a
  separate `createItem`, which goes through the same capability check, autonomy
  level and approvals as any Copilot write.

Without a request (an agent run, the queued chat worker) both skills fail with
`FILES_NOT_CONFIGURED`.

**External-action tools.** A tool whose effect lands outside the CMS is registered with a declared `risk`, `reversibility`, `blastRadius`, `capability` and secret references, and is decided on that declaration instead of the classification above. A high-risk or irreversible one waits for an approval at every autonomy level, and that approval can only be given by a signed-in user. Secrets are resolved from the `KeyProvider` when the handler runs and never reach the prompt, the tool result or a stored row. None is registered by default. See [external-action tools](features/external-action-tools.md).

**Standalone MCP server (`@lumibase/mcp-server`, `lumibase-mcp`).** A separate stdio server that wraps the REST API as ~105 MCP tools covering the full content-operations surface: content, RBAC, users/teams, intents/flows (incl. `get_flow_run`), webhooks, translations, translation-memory (incl. `update_tm`/`delete_tm`), search, media + `list_transform_presets`, preset resolution (`get_effective_preset`/`list_preset_bookmarks`), editorial workflow (`list_reviews`/`submit_review`/`approve_content`/`reject_content`), content releases (CRUD + `publish_release`), read-only deployments (`list_deployments`/`get_deployment_logs` — triggering stays governed), share links (`create_share`/`revoke_share`), `get_site`, ops, backup/restore, materialize, extensions, marketplace, and read-only **insights** (`list_dashboards`/`run_panel`/`query_insights`). It is an ungoverned passthrough — RBAC/tenancy are enforced server-side for the bearer token. Destructive tools require `confirm: true`. See `docs/en/agent-setup/`.

**Deliberately not on MCP.** These are excluded by design, not omission: realtime/SSE (`/realtime` — not request/response; poll via `cdc_events_read`), signed media delivery URLs (built at the edge with a server secret — no REST endpoint), binary upload/download (`/files`, `/uploads` — stream at the edge), security/GDPR admin (`/admin/encryption`, `/admin/sar`, `/admin/erasure`, `/retention`, `/scim-tokens`), auth/session and per-principal self-service (`/auth`, `/me/*`), and dev/infra tooling (`/typegen`, `/domains`, `/integrations/git`, `/firebase-sync`, `/push`).

> **Content versions are deliberately not in the standalone server.** `promoteVersion` mutates main and must run through HITL, which the stdio passthrough cannot enforce — so versioning is exposed only as governed harness skills (above), reachable through `POST /api/v1/mcp`. See [`docs/en/mcp/`](mcp/index.md) for the two-surface split and the phased rollout.

---

## 4. Packaging for AI

To enable AI to actually start "coding", organize your project directory as follows:

1. **`/docs/specs`**: Contains detailed Markdown files for each feature (Auth, File, Caching).
2. **`/docs/prompts`**: Contains the "Skills" listed above.
3. **`/schema`**: Contains initial SQL files or Prisma/Drizzle definition files.
4. **`.cursorrules` (If using Cursor):** Paste the entire "Technical Stack" and "Skills" here. AI will automatically follow these every time you write code.

---

## 5. Usage with AI Coding Assistants

When working with AI coding assistants (Cursor, GitHub Copilot, Claude, etc.), provide the following context:

```
You are working on LumiBase, an Edge-native Headless CMS. Follow these strict guidelines:

- Use NanoID or UUIDv7 for all IDs (no auto-increment)
- Every table must have site_id for multi-tenancy
- Build for Cloudflare Workers edge deployment
- Use Hono.js for backend APIs
- Implement cache tagging for invalidation
- Use Class Variance Authority for Tailwind mapping
- Design single-roundtrip APIs for optimal performance
- Follow the Technical Stack defined in docs/ai-skills.md

Refer to docs/ai-skills.md for detailed skill definitions and patterns.
```

---

## 6. Sponsorship Benefits

This AI Skills documentation is part of the exclusive content provided to GitHub Sponsors at the Hobby tier ($29/month) and above. Sponsors receive:

- Complete AI Skills documentation with detailed prompts
- Practical marketing strategies for developer tools
- Product launch playbooks
- Community building frameworks
- Content marketing templates
- Growth hacking techniques

[Become a Sponsor](https://github.com/sponsors/khuepm) to unlock these resources and accelerate your development with AI assistance.
