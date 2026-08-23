---
version: 2
lastUpdated: 2026-08-02T19:13:16.483Z
sourceLang: en
contentHash: 58eee638b9682bbc
---

# Claude Code — LumiBase Agent Setup

> **Claude Code** is a terminal-based coding agent made by Anthropic. It understands your codebase, runs commands, edits files, and manages git.
>
> **Tags:** Terminal · Standalone · Cloud · Extension

---

## Quick setup (recommended)

Run inside Claude Code to load full LumiBase context in one step:

```
Read docs/en/agent-setup/prompt.md and follow all setup instructions.
```

Or if you're on a remote copy of the docs:

```
Fetch https://raw.githubusercontent.com/khuepm/lumibase/main/docs/en/agent-setup/prompt.md
```

---

## Manual setup

### Step 1 — Open your project

```bash
cd /path/to/lumibase
claude
```

### Step 2 — Load project context

Paste the following into Claude Code:

```
Read docs/en/README.md to understand the LumiBase monorepo structure.
Then read docs/en/data-model.md for the database schema.
Then read docs/en/ai-skills.md for the skill system conventions.
```

### Step 3 — Add LumiBase rules to CLAUDE.md

Create or append to `CLAUDE.md` in the project root:

```markdown
## LumiBase development rules

- Use NanoID or UUIDv7 for all IDs — never auto-increment serial
- Every domain table must have `site_id` for multi-tenancy
- Business logic goes through `@lumibase/runtime` abstractions (not direct CF bindings)
- Prefer 1-roundtrip aggregated API responses
- Dangerous AI actions (schema:write, delete*) must create ai_approvals rows
- Cache invalidation must use tag-based approach (not key enumeration)
- Follow the stack: Hono.js + Drizzle ORM + PostgreSQL + Cloudflare Workers / Docker
```

### Step 4 — Set up the MCP server (optional)

If you want Claude Code to have live access to the LumiBase API:

Add to your Claude MCP config (`~/.claude.json` or `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "lumibase": {
      "url": "http://localhost:1989/mcp",
      "env": {
        "LUMIBASE_TOKEN": "<your-access-token>",
        "LUMIBASE_SITE_ID": "<your-site-id>"
      }
    }
  }
}
```

Then restart Claude Code and verify with: `/mcp`

---

## Key files for Claude Code

When starting a new task, point Claude Code to the relevant docs:

| Task | File to read |
|------|-------------|
| Add a new collection / field | `docs/en/data-model.md` + `docs/en/features/collections-builder.md` |
| Build a Flow / automation | `docs/en/features/flows-automation.md` |
| Work on AI Copilot | `docs/en/features/ai-copilot.md` + `packages/ai-skills/src/skills.ts` |
| Add an API route | `docs/en/api/hono-api-spec.md` + `apps/cms/src/routes/` |
| Add permissions logic | `docs/en/features/permissions-rbac.md` |
| Deploy to Cloudflare | `docs/en/deployment/cloudflare.md` |
| Run locally | `docs/en/deployment/local-development.md` |

---

## Example prompts

```
Read docs/en/features/flows-automation.md, then add a new "send-slack" operation type
to the operations engine. Follow the existing pattern for operation handlers.
```

```
Read docs/en/features/ai-copilot.md. Add a new AI skill called "publishCollection"
that sets a collection's status to "published". Mark it as safe (no HITL needed).
```

```
Read docs/en/data-model.md. Create a Drizzle migration to add a `tags` text[] column
to the items table, following the site_id multi-tenancy pattern.
```

---

## Troubleshooting

**Claude can't find the docs**: Make sure you're running `claude` from the project root, or provide the absolute path.

**Type errors after schema changes**: Run `pnpm -F @lumibase/database db:generate` to regenerate Drizzle types.

**CMS API not starting**: Check `apps/cms/.dev.vars` and ensure all required env vars are set (see `docs/en/deployment/environment-variables.md`).

---

← [Back to Agent Setup](./index.md)
