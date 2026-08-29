---
version: 2
lastUpdated: 2026-08-02T19:13:26.452Z
sourceLang: en
contentHash: cc662908e0e104bb
---

# Cursor — LumiBase Agent Setup

> **Cursor** is an AI-first IDE built on VS Code with multi-file Composer edits and background agents. Made by Cursor.
>
> **Tags:** Terminal · IDE · Standalone · Cloud

---

## Quick setup (recommended)

Open the Cursor chat (`Cmd+L`) and paste:

```
Read docs/en/agent-setup/prompt.md and follow all setup instructions.
```

---

## Manual setup

### Step 1 — Open the project

Open the `LumiBase` folder in Cursor (`File → Open Folder`).

### Step 2 — Configure `.cursorrules`

The project already has a `.cursorrules` file in the root. Verify it exists and includes LumiBase conventions. If not, create it:

```markdown
# LumiBase .cursorrules

You are working on LumiBase, an Edge-native Headless CMS built on Hono.js + PostgreSQL + Cloudflare Workers.

## Stack
- Backend: Hono.js (apps/cms) — deploys to Cloudflare Workers or Docker
- Frontend: React + Vite + TanStack Router (apps/studio)
- Database: PostgreSQL with Drizzle ORM (packages/database)
- Runtime abstraction: @lumibase/runtime (CacheProvider, StorageProvider, etc.)
- Auth: Logto (OIDC, multi-tenant)

## Strict rules
- IDs: Use NanoID or UUIDv7. Never auto-increment.
- Multi-tenancy: Every domain table has `site_id`. Every query scopes with WHERE site_id = :siteId.
- Edge-friendliness: Never call CF KV/R2 directly. Use @lumibase/runtime adapters.
- API style: 1-roundtrip aggregated responses. Avoid N+1.
- AI safety: Dangerous skills (schema:write, delete*) must create ai_approvals rows.
- Cache: Tag-based invalidation only.

## Key docs
- docs/en/README.md — full docs map
- docs/en/data-model.md — DB schema
- docs/en/features/ai-copilot.md — AI Copilot internals
- docs/en/api/hono-api-spec.md — REST/WS API spec
```

### Step 3 — Add docs to Cursor's context

In Cursor Settings (`Cmd+,` → Features → Docs), add:

- Index `docs/en/` as a local docs folder, or
- Paste `docs/en/README.md` into the Composer context when starting a new task.

### Step 4 — Set up the MCP server (optional)

Add to `.cursor/mcp.json` in the project root (create if missing):

```json
{
  "mcpServers": {
    "lumibase": {
      "url": "http://localhost:1989/mcp"
    }
  }
}
```

Set `LUMIBASE_TOKEN` and `LUMIBASE_SITE_ID` as environment variables or in `.env`.

Restart Cursor to load the MCP server. Verify via the Cursor MCP panel.

---

## Using Composer for LumiBase tasks

Cursor's **Composer** mode (`Cmd+I`) works well for multi-file LumiBase tasks:

```
@docs/en/features/flows-automation.md
Add a new "notify-slack" operation type to the Flows engine.
Follow the existing pattern in apps/cms/src/services/flow-service.ts.
Create the operation handler, register it in the operation registry, and add types to packages/shared.
```

```
@docs/en/features/permissions-rbac.md @packages/database/src/schema/
Add a new capability token "reports:read" and wire it through the permissions system.
Update the policy evaluation logic in apps/cms/src/services/permission-service.ts.
```

---

## Background agents

Cursor background agents work well for longer LumiBase tasks like:

- Running the full test suite while you keep coding
- Generating TypeScript types from the Drizzle schema
- Linting and fixing all files in a package

```bash
# Generate types (run in terminal or via background agent)
pnpm -F @lumibase/database db:generate
pnpm -F @lumibase/sdk typegen
```

---

## Codebase indexing tips

Cursor's codebase index will pick up the whole monorepo. To help it focus:

- **Exclude** from index: `node_modules/`, `.pnpm-store/`, `.wrangler/`, `dist/`, `.turbo/`
- **Include priority**: `apps/cms/src/`, `packages/database/src/`, `packages/ai-skills/src/`, `docs/en/`

Configure in Cursor Settings → Features → Codebase Index.

---

## Troubleshooting

**Cursor suggests wrong imports**: The monorepo uses `pnpm` workspaces. Ensure TypeScript paths are configured via `tsconfig.base.json` in the root.

**MCP server not connecting**: Start the CMS API first (`pnpm -F @lumibase/cms dev`), then reload the MCP connection in Cursor.

**Drizzle types out of date**: Run `pnpm -F @lumibase/database db:generate` after any schema change.

---

← [Back to Agent Setup](./index.md)
