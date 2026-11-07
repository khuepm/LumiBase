---
version: 4
lastUpdated: 2026-11-07T15:50:32.223Z
sourceLang: vi
contentHash: ecc8983d3122446b
codeVerified: 2026-11-07T15:50:32.223Z
codeVerifiedHash: e4b0a90c3c2e2af9
codeVerifiedClaims: 28
translatedFrom: vi
sourceHash: e4b0a90c3c2e2af9
mtEngine: manual
syncStatus: human-translated
---

# AI Copilot (HITL)

LumiBase Studio ships with an AI Copilot that can take natural-language commands from an admin and execute the skills declared on the CMS. This is the seed of the **Agent Harness Layer**: the agent receives goal/context/permissions through the harness, calls tools per the registry, is risk-evaluated, and leaves an audit trail. Every dangerous action (touching the schema or deleting data) must go through **Human-in-the-Loop (HITL)**: the AI creates an `ai_approvals` row awaiting admin approval rather than executing directly.

> The historical documentation of the implementation phase (split into 4 modules for the AI agent) is in [`ai-first-specification.md`](./ai-first-specification.md). The strategic blueprint for expanding the Copilot into a control plane for agents is in [`agent-harness-layer.md`](./agent-harness-layer.md). This file focuses on end-user behavior and the API contract.

## The 4-module architecture

| Module | Main file | Responsibility |
|--------|-----------|-------------|
| **A. Schema** | `packages/database/src/schema/ai.ts` (`ai_approvals`) | Store the approval state |
| **B. Harness** | `apps/cms/src/services/ai-harness.ts` (`AISecureHarness`) | Validate the skill, check capability, evaluate risk, execute or gate via HITL |
| **C. Routes** | `apps/cms/src/routes/ai.ts` (`aiRouter`) | `/api/v1/ai/chat`, `/api/v1/ai/approvals`, `/api/v1/ai/approvals/:id/decide` |
| **D. Studio UI** | `apps/studio/src/components/ai-assistant.tsx`, `apps/studio/src/modules/settings/ai-approvals.tsx` | Floating chat panel + Approvals dashboard |

## Relationship to the Agent Harness Layer

The current AI Copilot handles a short loop: chat → choose a skill → risk/capability check → execute or create an approval. The Agent Harness Layer extends this same principle to a longer loop:

```text
Goal → Run → Plan → Tool calls → Evaluation → Approval → Artifact commit → Memory update
```

So the existing tables are seen as seeds:

- `ai_approvals` → the precursor to a general approval gate for plan/tool/artifact.
- `ai_conversations` + `ai_messages` → short-term context memory.
- `ai_embeddings` → reserved for a RAG knowledge base by site/collection/item. Nothing reads or writes it yet (#581).
- `CORE_SKILLS` → the precursor to a tool registry with an input schema, capability, rate limit, and risk policy.

## CORE_SKILLS registry

Skills are declared centrally in `packages/ai-skills/src/skills.ts`. Each skill contains:

- `name`, `description` (the description is used for LLM tool calling).
- `parameters` — OpenAI-compatible JSON Schema.
- `requiredCapabilities` — must be satisfied against the session's capabilities.

Current skills: `listCollections`, `createCollection`, `deleteCollection`, `createField`, `deleteField`, `listItems`, `createItem`, `updateItem`, `deleteItem`.

The `getAISkillsAsTools()` helper returns an OpenAI function-calling tool list — used when integrating a real LLM.

## Risk evaluation rules

A skill is classified as **dangerous** (requires HITL) if:

- It requires the `'schema:write'` capability, **or**
- The skill name starts with `'delete'`.

Otherwise it is **safe** → execute directly.

A wildcard `'*'` in the user's capabilities satisfies every requirement.

## End-to-end flow

```
┌──────────────┐  POST /api/v1/ai/chat
│ AI Assistant │ ─────────► [Hono router]
│ (Studio UI)  │              │
└──────┬───────┘              ▼
       │              [AISecureHarness.execute]
       │                       │
       │            ┌──────────┼──────────┐
       │            ▼          ▼          ▼
       │       validate    capability   risk
       │       skill       check         eval
       │            │          │          │
       │            └──────────┴──────────┘
       │                       │
       │              ┌────────┴────────┐
       │              ▼                 ▼
       │         safe → run       dangerous →
       │         skill direct     INSERT ai_approvals
       │                                │
       │                          status=pending
       │                                ▼
       │                       respond { status:
       │                       'pending_approval',
       │                       approvalId }
       │                                │
       │             ┌──────────────────┘
       │             │
       ▼             ▼
┌──────────────┐  GET /api/v1/ai/approvals
│ Approvals    │ ─────────► [list pending for siteId]
│ Dashboard    │
│              │  POST /api/v1/ai/approvals/:id/decide
│              │ ─────────► executeApproved | rejectApproval
└──────────────┘
```

## API contract

### `POST /api/v1/ai/chat`

Request: `{ "message": string }` (1-2000 chars after trim).

Response 200: `{ "data": { "status": "executed" | "pending_approval" | "denied", "data"?, "approvalId"?, "message"? } }`.

Response 400: validation error.

### `GET /api/v1/ai/approvals`

Returns up to 100 approvals with `status='pending'` in the current site, sorted `createdAt DESC`.

### `POST /api/v1/ai/approvals/:id/decide`

Body: `{ "decision": "approved" | "rejected" }`.

- `"approved"` → the harness executes the skill with the saved arguments and updates the status to `approved` (if execution succeeds). If the skill fails, the status stays `pending` so the admin can retry.
- `"rejected"` → updates the status to `rejected`.

Every query is scoped by `siteId` — a request from site B never sees site A's records (HTTP 403, without revealing existence).

## Studio UI

### AI Assistant panel

- A 48×48px floating button at `bottom: 24px, right: 24px`.
- Clicking opens a 320×480px panel, glassmorphism (backdrop-blur).
- Distinguishes the `user` vs `assistant` roles.
- Shows a `pending_approval` badge when applicable.
- History up to 50 messages, reset on page reload.

### Approvals Dashboard

- `apps/studio/src/modules/settings/ai-approvals.tsx`.
- Card view; each card: `skillName`, `arguments` (JSON pretty 2 spaces), `context`.
- Two buttons **Approve** / **Reject** with a loading state — both disabled while processing.
- An empty state when there is nothing pending.

## Multi-tenancy

- Every insert/select/update on the `ai_approvals` table is `WHERE siteId = currentSiteId`.
- Cross-site access → 403, without revealing whether the record exists in another site.
- The tenant middleware (`withTenant`) requires resolving `siteId` before the AI router operates.

## Real LLM integration & Context Memory (RAG)

The LumiBase Copilot is fully integrated with large language models (LLMs) and a vector/chat-history store:

### 1. LLM Providers
The system supports multiple LLM providers (configured via the `LLM_PROVIDER` env, model via `LLM_MODEL`):
- **OpenAI**: Uses Chat Completions tool calling (e.g. `gpt-4.1-nano`, default `gpt-4o-mini`).
- **Anthropic / Claude**: Uses the Claude model family via native `tool_use`.
- **Gemini**: Uses the Gemini REST `generateContent` with function declarations.
- **Workers AI**: Runs directly at the edge on Cloudflare Workers AI (defaults to `@cf/meta/llama-3.1-8b-instruct`).
- **Echo**: A keyword matcher (fallback mock) for test environments or when API credentials are missing.

### 2. Context Memory (Conversation history)
The `ai_conversations` and `ai_messages` tables store the state of conversation threads:
- Whenever a message is sent to `/api/v1/ai/chat`, the system loads up to the **20 most recent messages** as the context window passed to the LLM.
- Full management APIs are supported: `GET /conversations`, `GET /conversations/:id/messages`, `DELETE /conversations/:id`.
- A conversation belongs to the user who started it (#579). Another member of the site gets `404` on its messages, a `DELETE` removes nothing, and a `POST /chat` with that `conversationId` starts a new conversation for the caller. An API-key caller owns only the conversations recorded with its own key (`api_key_id`, migration `0023`), so one key cannot list, read, delete or append to another key's conversation. User-less conversations created before `0023` have no recorded key and no API key owns them.

### Trust boundaries (#579)

- **Instructions vs data.** Only the Copilot chat uses the Copilot system prompt and the tool list. Every other model call (generation skills, constitution compiler and judge, intent compiler, decisions) sends its own instructions in the provider's system slot with tools disabled (`completeWithInstructions`). The constitution judge sends the content under review as the only user turn, inside an `<untrusted>` block. A source-scan test fails when a new call skips this.
- **One tool call per turn, no tool output in the prompt.** `POST /chat` executes at most the first tool call the model returns, and tool results go to the client, not back to the model. A multi-step attack therefore needs one user turn per step, and each turn is authorized on its own.
- **The model grants no rights.** The harness checks capabilities, the canonical input schema, and the caller's row and field permissions on every tool call, whatever the model asked for. `apps/cms/eval/prompt-injection/dataset.v1.json` lists attacks and benign controls that are replayed as if the model followed the attacker.
- **Redaction.** `listSettings` redacts secret-bearing fields with the same rule as `GET /api/v1/settings`.

### 3. Generation skills with context (`aiSuggestField` and `aiContentAssist`)
Neither skill runs a vector search today (#581). `embedding-service.ts` (OpenAI `text-embedding-3-small`, Workers AI `@cf/baai/bge-base-en-v1.5`) and the `ai_embeddings` table exist, but no code path calls or fills them.
- **`aiSuggestField`**: sends the collection's existing field names and the admin's description to the model.
- **`aiContentAssist`**: sends up to 3 sample items of the collection, the most recently updated items the caller may read. `ItemService` applies the tenant, row and field rules, so a hidden field, another site's item or an item outside the row rule never reaches the model. An update, a delete or a revoked permission takes effect on the next call. Only each sample's `status` and `data` are sent, not row metadata. The samples do not depend on the instruction. `apps/cms/eval/retrieval/dataset.v1.json` records the baseline on that dataset (Recall@3 0.5, MRR@3 0.46).
- The embedding primitives throw `EMBEDDING_DIMENSION_MISMATCH` or `EMBEDDING_RESPONSE_INVALID` when vectors of different sizes are compared or a provider returns the wrong number or size of vectors.

## Property-based testing

The system has 15 property tests (fast-check, ≥100 iterations) fully listed in `.kiro/specs/ai-first-cms-engine/design.md` under "Correctness Properties". The tests are in:

- `apps/cms/src/services/__tests__/ai-harness-*.property.test.ts` — Properties 1-8 (Module B).
- `apps/cms/src/routes/__tests__/ai-*.property.test.ts` — Properties 9-12 (Module C).
- `apps/studio/src/modules/settings/__tests__/` — Properties 13-14 (Module D).
- `packages/database/src/__tests__/` — Property 15 (round-trip).
