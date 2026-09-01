---
version: 2
lastUpdated: 2026-08-02T19:12:50.738Z
sourceLang: en
contentHash: 9ec0cbf5e5010696
---

# Windsurf — LumiBase Agent Setup

> **Windsurf** is an agentic IDE with Cascade context engine and Flows automation for multi-step tasks. Made by Cognition.
>
> **Tags:** IDE · Standalone

---

## Quick setup (recommended)

Open Windsurf's Cascade panel and paste:

```
Read docs/en/agent-setup/prompt.md and follow all setup instructions.
```

---

## Manual setup

### Step 1 — Open the project

Open the `LumiBase` root folder in Windsurf.

### Step 2 — Configure the MCP server (optional)

Add to `~/.codeium/windsurf/mcp_config.json` (note: uses `serverUrl`, not `url`):

```json
{
  "mcpServers": {
    "lumibase": {
      "serverUrl": "http://localhost:1989/mcp"
    }
  }
}
```

Set auth headers via shell environment before starting Windsurf:

```bash
export LUMIBASE_TOKEN=<your-access-token>
export LUMIBASE_SITE_ID=<your-site-id>
```

OAuth triggers automatically on first tool use if the MCP server supports it.

Restart Windsurf to load the new MCP server.

### Step 3 — Load LumiBase context into Cascade

In the Cascade panel, start with:

```
Read docs/en/README.md for the full docs map.
Read docs/en/data-model.md for the database schema.
Read docs/en/ai-skills.md for AI skill conventions.
Then confirm you understand the LumiBase monorepo structure.
```

---

## Using Cascade Flows for LumiBase

Windsurf's Cascade context engine is excellent for multi-file LumiBase changes. Use **Flows** for longer tasks:

```
Flow: Add realtime notifications to the Flows engine
1. Read docs/en/features/flows-automation.md and docs/en/features/websockets-realtime.md
2. Add a "notify" operation type to the operation registry in apps/cms/src/services/
3. Implement the WebSocket push in the existing realtime service
4. Update types in packages/contracts
5. Run pnpm typecheck to confirm no errors
```

```
Flow: Implement SCIM user provisioning
1. Read docs/en/features/scim-provisioning.md
2. Create the SCIM router at apps/cms/src/routes/scim.ts
3. Implement /scim/v2/Users (GET, POST, PUT, DELETE)
4. Wire multi-tenancy: scope all queries to site_id
5. Write unit tests following the pattern in apps/cms/src/__tests__/
```

---

## Deep codebase search

Windsurf's deep codebase search works well for LumiBase's monorepo. Useful queries:

- `"site_id"` — find all multi-tenancy patterns
- `"withTenant"` — find middleware usage
- `"ai_approvals"` — find all HITL integration points
- `"CORE_SKILLS"` — find the AI skill registry

---

## Command suggestions

Windsurf suggests terminal commands automatically. Common LumiBase commands:

```bash
pnpm install                          # Install all workspace dependencies
pnpm dev                              # Start CMS + Studio + Docs
pnpm -F @lumibase/cms dev             # CMS API only (port 1989)
pnpm -F @lumibase/studio dev          # Studio only (port 2026)
pnpm -F @lumibase/database db:generate   # Regenerate Drizzle types
pnpm typecheck                        # Type-check all packages
pnpm test                             # Run all tests
```

---

## Troubleshooting

**Cascade loses context mid-task**: Paste `docs/en/README.md` content at the start of long sessions to anchor Cascade's context.

**MCP server not available**: Ensure `apps/cms` is running (`pnpm -F @lumibase/cms dev`) before Windsurf connects to the MCP endpoint.

**Import resolution errors**: The monorepo uses pnpm workspaces. Run `pnpm install` from the root if workspace links are broken.

---

← [Back to Agent Setup](./index.md)
