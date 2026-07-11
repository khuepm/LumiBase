---
version: 1
lastUpdated: 2026-07-08T20:22:25.910Z
sourceLang: en
contentHash: ce887b90495381f9
---

# GitHub Copilot — LumiBase Agent Setup

> **GitHub Copilot** is an editor extension and CLI with agent mode, workspace context, and native PR integration. Made by GitHub.
>
> **Tags:** Terminal · Cloud · Extension

---

## Quick setup (recommended)

Open GitHub Copilot Chat in VS Code and paste:

```
Read docs/en/agent-setup/prompt.md and follow all setup instructions.
```

---

## Manual setup

### Step 1 — Open the project in VS Code

```bash
code /path/to/lumibase
```

Ensure the GitHub Copilot extension is installed and authenticated.

### Step 2 — Create a workspace instructions file

Create `.github/copilot-instructions.md` in the project root:

```markdown
# LumiBase — Copilot workspace instructions

You are working on LumiBase, an Edge-native Headless CMS.

## Stack
- **API**: Hono.js (apps/cms) — dual-runtime: Cloudflare Workers + Docker/Node.js
- **DB**: PostgreSQL + Drizzle ORM (packages/database), JSONB hybrid schema
- **Studio**: React + Vite + TanStack Router (apps/studio)
- **Runtime abstraction**: @lumibase/runtime — use this, never call CF APIs directly
- **Auth**: Logto OIDC, multi-tenant (every request carries siteId)
- **AI**: OpenAI / Anthropic / CF Workers AI — via packages/ai-skills

## Mandatory rules
1. IDs: NanoID or UUIDv7 only. No serial/auto-increment.
2. Multi-tenancy: `site_id` on every domain table, every query scoped.
3. AI safety: Skills with `schema:write` or `delete*` → HITL via ai_approvals table.
4. Performance: Aggregated 1-roundtrip responses, cache-tagged invalidation.

## Key documentation
Read these files before making changes in their area:
- docs/en/data-model.md (schema)
- docs/en/features/ai-copilot.md (AI Copilot)
- docs/en/api/hono-api-spec.md (API spec)
- docs/en/features/flows-automation.md (Flows engine)
- docs/en/features/permissions-rbac.md (permissions)
```

### Step 3 — Set up the MCP server (optional)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "lumibase": {
      "type": "http",
      "url": "http://localhost:1989/mcp",
      "headers": {
        "Authorization": "Bearer ${env:LUMIBASE_TOKEN}",
        "X-Site-Id": "${env:LUMIBASE_SITE_ID}"
      }
    }
  }
}
```

Set `LUMIBASE_TOKEN` and `LUMIBASE_SITE_ID` in your shell environment or `.env`.

Reload VS Code and check the MCP panel (`Cmd+Shift+P` → "MCP: List Servers").

---

## Agent mode

Enable GitHub Copilot Agent Mode in VS Code (`Cmd+Shift+P` → "GitHub Copilot: Enable Agent Mode").

Example agent prompts for LumiBase:

```
#file:docs/en/features/flows-automation.md
Add a "retry" mechanism to the Flow runner so failed operations retry up to 3 times with exponential backoff.
Modify apps/cms/src/services/flow-service.ts and update the flow_runs schema in packages/database.
```

```
#file:docs/en/features/ai-copilot.md #file:packages/ai-skills/src/skills.ts
Add a new AI skill "exportCollection" that exports all items from a collection as CSV.
Mark it as safe (no HITL needed). Register it in CORE_SKILLS and implement the handler.
```

---

## Workspace context tips

Copilot workspace context (`#workspace`) works well when:

1. You've opened the monorepo root as the VS Code workspace
2. The relevant source files are open in editor tabs
3. You reference docs files with `#file:` in your prompt

**Recommended files to keep open** when working on LumiBase:

- `docs/en/README.md`
- `docs/en/data-model.md`
- `apps/cms/src/index.ts`
- The specific route/service file you're editing

---

## PR summaries

GitHub Copilot can generate PR descriptions for LumiBase changes. Ask it to:

```
Write a PR description for these changes. Reference the relevant docs files
(docs/en/features/, docs/en/data-model.md) and follow conventional commits format.
```

---

## CLI integration

With GitHub Copilot CLI:

```bash
# Ask about a specific LumiBase pattern
gh copilot suggest "how do I add a new Hono route with multi-tenant middleware in LumiBase"

# Explain existing code
gh copilot explain "apps/cms/src/services/ai-harness.ts"
```

---

## Troubleshooting

**Copilot doesn't know LumiBase conventions**: Ensure `.github/copilot-instructions.md` is committed and VS Code has reloaded the workspace.

**MCP server not showing up**: The MCP server requires `apps/cms` to be running locally. Start it with `pnpm -F @lumibase/cms dev`.

**Type errors in generated code**: Run `pnpm typecheck` in the affected package to identify mismatches, then show the error to Copilot.

---

← [Back to Agent Setup](./index.md)
