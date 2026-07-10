---
version: 1
lastUpdated: 2026-07-08T20:22:25.809Z
sourceLang: en
contentHash: 051a5ab7df48ac91
---

# Codex — LumiBase Agent Setup

> **Codex** is a lightweight open-source terminal agent that reads and writes files, runs commands, and browses the web in a sandbox. Made by OpenAI.
>
> **Tags:** Terminal · Standalone · Cloud · Extension · Open Source

---

## Quick setup (recommended)

```bash
codex "Read docs/en/agent-setup/prompt.md and follow all setup instructions."
```

---

## Manual setup

### Step 1 — Install Codex

```bash
npm install -g @openai/codex
```

Authenticate:
```bash
export OPENAI_API_KEY=<your-key>
```

### Step 2 — Navigate to the project

```bash
cd /path/to/lumibase
```

### Step 3 — Load LumiBase context

```bash
codex "Read docs/en/README.md and docs/en/data-model.md to understand the LumiBase codebase structure and conventions."
```

### Step 4 — Create a context file (optional)

Codex respects `AGENTS.md` or `codex.md` in the project root. Create one:

```bash
cat > AGENTS.md << 'EOF'
# LumiBase agent context

You are working on LumiBase, an Edge-native Headless CMS.

Stack: Hono.js API (apps/cms), React+Vite Studio (apps/studio), PostgreSQL+Drizzle (packages/database), Cloudflare Workers + Docker dual-runtime.

Rules:
- IDs: NanoID or UUIDv7. Never auto-increment serial.
- Multi-tenancy: site_id on every domain table, scoped in every query.
- Runtime: use @lumibase/runtime abstractions, never direct CF KV/R2 bindings.
- AI safety: dangerous skills (schema:write, delete*) must gate through ai_approvals.
- Cache: tag-based invalidation only.

Key docs:
- docs/en/data-model.md
- docs/en/api/hono-api-spec.md
- docs/en/features/ai-copilot.md
- docs/en/features/flows-automation.md
EOF
```

### Step 5 — Add MCP server (optional)

```bash
codex mcp add lumibase --url http://localhost:1989/mcp
```

Set auth via environment:
```bash
export LUMIBASE_TOKEN=<your-access-token>
export LUMIBASE_SITE_ID=<your-site-id>
```

---

## Example Codex sessions

```bash
# Add a new API route
codex "Read docs/en/api/hono-api-spec.md. Add a GET /api/v1/stats endpoint that returns site-level counts for collections, items, users, and files. Scope by site_id."

# Extend the Flows engine
codex "Read docs/en/features/flows-automation.md. Add a 'webhook-verify' operation that validates an HMAC-SHA256 signature on incoming webhook payloads."

# Fix a bug with context
codex "apps/cms/src/services/flow-service.ts has a bug where failed flow_runs are not saving the error message. Read the file and fix it."
```

---

## Sandbox mode

Codex runs in a sandboxed environment. For LumiBase development:

```bash
# Codex can read/write files and run commands — useful for:
codex "Run pnpm typecheck in packages/database and fix any TypeScript errors."
codex "Generate Drizzle migration SQL for adding a tags column to the flows table."
```

---

## Troubleshooting

**Codex doesn't understand monorepo structure**: Point it at `docs/en/README.md` first, which maps all packages and apps.

**Commands fail in sandbox**: Some pnpm workspace commands need the workspace root. Tell Codex: "Run this from the project root, not from a subdirectory."

---

← [Back to Agent Setup](./index.md)
