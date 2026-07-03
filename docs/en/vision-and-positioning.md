---
version: 1
lastUpdated: 2026-06-23T13:05:48.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: bd0ba5b5bf9cfe5f
mtEngine: claude
syncStatus: machine-translated
---

# LumiBase Vision & Positioning vs Directus

## 1. Positioning summary

LumiBase = **Directus DX + Edge-native runtime + native Multi-tenant + an Agent Harness Layer**.

We do NOT clone Directus — we take what Directus does best (No-code builder, fine-grained Permissions, Extension SDK, Presets, Translations, Display Templates, Realtime, Flows/Automation, a database-first API) and level it up toward an **AI-native backend operating system**: where humans, agents, data, workflows, and applications co-evolve under control.

## 1.1. Comparison Ledger for marketing

Whenever you design or implement a feature that Directus does not have first-class, you must update the corresponding comparison table in the feature's documentation. For the Permission Builder/RBAC, the primary ledger is in [permission-builder-directus-investigation.md](./features/permission-builder-directus-investigation.md#11-bảng-so-sánh-lumibase-vs-directus).

Update rules:

- If a feature is parity with Directus, mark it `Parity`.
- If it's the same use case but LumiBase does it more safely or operates it better, mark it `Improve`.
- If Directus doesn't have it first-class, mark it `New` and describe it as a reusable marketing claim.
- Do not record a claim without evidence from the official docs, a sample DB, or an implementation in the repo.


## 1.2. The AI-native thesis

Directus is powerful because it turns a database into a well-governed CMS/API for humans. LumiBase must go further: turn the CMS into a **control plane for AI Agents**. Agents are not allowed to "fly around freely"; an agent operates within a harness made of goal, context, plan, tool calls, validation, approval, artifact commit, and audit trail.

Product definition:

> LumiBase is not just a CMS where humans manage content. It is a structured operating layer where humans, agents, data, workflows, and applications co-evolve.

Three strategic layers:

1. **CMS Layer** — schema, content, users, roles, policies, files, revisions, activity.
2. **Agent Harness Layer** — goals, runs, plans, tools, memory, approvals, evaluations, permissions, audit.
3. **App Generation Layer** — agents use the schema/content to generate pages, components, datasets, config, prompts, migrations, API specs, and automation.

See the detailed blueprint at [Agent Harness Layer](./features/agent-harness-layer.md).

## 2. Highlights comparison

### Collection Builder

- **Directus**: Form-based, good
- **LumiBase**: Drag-drop + JSON live-preview + AI field suggestions
- **Difference**: Two-way — UI ↔ JSON schema in realtime

### Field configuration

- **Directus**: Interface + Display + Conditions
- **LumiBase**: + a per-field validator pipeline (Zod/JSONata),
  per-field encryption, per-field versioning toggle
- **Difference**: A standardized Field DSL

### Permissions

- **Directus**: Role × Collection × Action + rules
- **LumiBase**: Role + Policy (attachable) + Field-level +
  Row-level + Time limits + IP limits
- **Difference**: A JSON Rule Engine (jsonata/cel) + policy composition

### Raw Editor

- **Directus**: Available for some fields
- **LumiBase**: Raw mode can be enabled for EVERY field — with inline schema validation
- **Difference**: "Toggle raw" is a fixed API contract

### User management

- **Directus**: Basic + Roles
- **LumiBase**: + Team/Group, Impersonate, Session manager,
  device list, per-user Audit
- **Difference**: Logto OIDC integration, SCIM-ready

### Extensions

- **Directus**: Hooks / Endpoints / Modules / Interfaces /
  Displays / Layouts / Panels / Operations
- **LumiBase**: + a Capability-based Sandbox (the manifest declares permissions),
  signed extensions, an edge-safe runtime
- **Difference**: A permission gate before hook execution

### Configuration

- **Directus**: Settings table + env
- **LumiBase**: Layered config — env → site → user,
  hot-reload via KV, diff/rollback
- **Difference**: Two-way Config-as-Code

### Bookmarks / Presets

- **Directus**: Preset per user/role/collection
- **LumiBase**: + Shared workspace presets,
  smart presets (saved query + alert)
- **Difference**: Presets can subscribe in realtime

### Translations

- **Directus**: i18n for fields + UI strings
- **LumiBase**: + Glossary, MT plug-ins (DeepL/OpenAI),
  per-locale workflow status
- **Difference**: A translation-memory store

### Display Templates

- **Directus**: `{{field}}` mustache + Display
- **LumiBase**: + component-based templates (CVA),
  conditional slots, template inheritance
- **Difference**: Templates render edge-side

### WebSocket

- **Directus**: Yes (REST-mirror subscribe)
- **LumiBase**: + Presence, collaborative cursors,
  op-based patch (CRDT-lite)
- **Difference**: Cloudflare Durable Objects

### Agent Harness

- **Directus**: Has a CMS/API/Flows/Extensions foundation for automation to run around the data
- **LumiBase**: + first-class agent goals, runs, tools, memory, approvals, evaluations, and an artifact store
- **Difference**: Agents are governed by the harness: permissions come from a policy snapshot, risky actions require HITL, and output is versioned/evaluated before commit

### App Generation

- **Directus**: Mainly governs data/API for developers or integrations to consume
- **LumiBase**: + agents read the schema/content/policy to generate storefronts, dashboards, workflows, API docs, seed data, migrations
- **Difference**: The CMS becomes the source of truth for agents to create business software under control

## 3. What we will NOT do (Non-goals)

- We do not build our own IdP — we use **Logto** (OIDC).
- We do not build a GUI workflow engine in v1 — that's Phase 2 (Operations/Flows).
- We do not support MySQL/SQLite at MVP — only Postgres (Hyperdrive).

## 4. Target users

- **Site Admin**: sets up collections, roles, policies, extensions, agent goals, and approval policies.
- **Editor**: creates/edits content, uses presets, bookmarks, translations.
- **Developer**: writes extensions/tools, uses the API, defines display templates, and reviews generated artifacts.
- **Agent Operator**: creates goals, watches runs, approves plans/artifacts, views eval/audit.
- **End-user (Delivery)**: consumes via REST/GraphQL/WS from the Next.js demo.

## 5. Technical KPIs

- p95 Delivery API < 80ms at the edge.
- Studio TTI < 2s with 1k collections.
- Permission checks < 1ms (KV cache hit) / < 15ms (cold).
- WebSocket fan-out < 200ms globally (Durable Objects regional).
- 100% of agent runs have a goal, plan/tool-call log, approval/evaluation state, and an artifact hash when producing output.
