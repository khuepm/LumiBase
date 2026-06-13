# Agent Setup — LumiBase

> **For AI agents:** This page is also available as clean Markdown. If you are reading HTML, request `index.md` instead. For the full page index, see [`llms.txt`](../llms.txt).

LumiBase provides a [prompt template](./prompt.md), MCP server configs, and structured context files so AI coding agents can understand the codebase, call the API, and build features correctly. Pick your agent below to get started.

---

## Quick setup

Already have an agent? Paste this into any AI coding agent to load the LumiBase project context in one step:

```
Fetch https://raw.githubusercontent.com/lumibase/lumibase/main/docs/en/agent-setup/prompt.md
```

Or if you're working locally, tell your agent:

```
Read docs/en/agent-setup/prompt.md and follow all setup instructions.
```

---

## Manual setup — Pick your agent

Select your agent to view step-by-step instructions for wiring up LumiBase context and (optionally) the MCP server.

| Agent | Type | Guide |
|-------|------|-------|
| [Claude Code](./claude-code.md) | Terminal · Standalone · Cloud · Extension | [View guide →](./claude-code.md) |
| [Codex](./codex.md) | Terminal · Standalone · Cloud · Extension · Open Source | [View guide →](./codex.md) |
| [Cursor](./cursor.md) | Terminal · IDE · Standalone · Cloud | [View guide →](./cursor.md) |
| [GitHub Copilot](./github-copilot.md) | Terminal · Cloud · Extension | [View guide →](./github-copilot.md) |
| [Windsurf](./windsurf.md) | IDE · Standalone | [View guide →](./windsurf.md) |

---

## Agent-friendly docs

LumiBase structures its documentation to be token-efficient and easy to consume in a context window.

### Markdown versions

Append `/index.md` to any LumiBase docs URL to get a clean Markdown version.

### Page indexes (llms.txt)

Every top-level section has its own `llms.txt` — a page index sized to fit in a single context window:

- [`docs/llms.txt`](../../llms.txt) — directory of all LumiBase docs.
- [`docs/en/llms.txt`](../llms.txt) — full English docs index.

### Agent prompt

[`docs/en/agent-setup/prompt.md`](./prompt.md) — machine-readable setup instructions for configuring any agent to work with LumiBase. Designed to be fetched and executed directly by an agent.

---

## What agents can do with LumiBase

Once set up, your agent can:

- **Read and write collections** — `GET/POST/PATCH/DELETE /api/v1/items/:collection`
- **Manage schema** — create collections, add fields, configure relations via CMS API
- **Trigger and monitor Flows** — `POST /api/v1/flows/:id/run`, `GET /api/v1/flows/:id/runs`
- **Query the AI Copilot** — `POST /api/v1/ai/chat` with natural-language instructions
- **Upload assets** — `POST /api/v1/files` (R2/local storage via runtime abstraction)
- **Manage users and roles** — `GET/POST /api/v1/users`, roles, permissions, policies
- **Use WebSocket realtime** — subscribe to collection changes, presence, collaborative cursors

All endpoints require a valid access token (`Authorization: Bearer <token>`) scoped to the site (`X-Site-Id` header or subdomain routing). See [`api/hono-api-spec.md`](../api/hono-api-spec.md) for the full REST/WS reference.

---

## Compare agents

| Agent | Terminal | IDE | Extension | Cloud | Open Source | Model |
|-------|:--------:|:---:|:---------:|:-----:|:-----------:|-------|
| Claude Code | ✓ | — | ✓ | ✓ | — | Claude (locked) |
| Codex | ✓ | — | ✓ | ✓ | ✓ | GPT-4o (locked) |
| Cursor | ✓ | ✓ | — | ✓ | — | Multi-provider |
| GitHub Copilot | ✓ | — | ✓ | ✓ | — | Multi-provider |
| Windsurf | — | ✓ | — | — | — | Multi-provider |

---

## Resources

- **REST API spec**: [`docs/en/api/hono-api-spec.md`](../api/hono-api-spec.md)
- **Data model**: [`docs/en/data-model.md`](../data-model.md)
- **AI Copilot internals**: [`docs/en/features/ai-copilot.md`](../features/ai-copilot.md)
- **AI skills registry**: [`docs/en/ai-skills.md`](../ai-skills.md)
- **Flows automation**: [`docs/en/features/flows-automation.md`](../features/flows-automation.md)
- **Architecture overview**: [`docs/en/architecture/overview.md`](../architecture/overview.md)
- **Permissions / RBAC**: [`docs/en/features/permissions-rbac.md`](../features/permissions-rbac.md)
- **Deployment**: [`docs/en/deployment/overview.md`](../deployment/overview.md)
