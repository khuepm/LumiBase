# `@lumibase/mcp-server`

Stdio [Model Context Protocol](https://modelcontextprotocol.io) server for [LumiBase](https://lumibase.dev). Lets AI assistants (Claude Code, Cursor, Windsurf, …) manage collections, fields, items, editorial workflow, releases, insights, and more against a running CMS over REST.

```bash
npm install -g @lumibase/mcp-server
# or run without installing:
npx @lumibase/mcp-server
# binary name:
lumibase-mcp
```

## Configure

Point the server at your CMS with environment variables:

| Variable | Required | Example |
| --- | --- | --- |
| `LUMIBASE_URL` | Yes | `https://api.mysite.lumibase.dev` or `http://localhost:1989` |
| `LUMIBASE_SITE_ID` | Yes | `site_abc123` |
| `LUMIBASE_TOKEN` | Yes | Bearer token with the roles you want the agent to inherit |

Example MCP client config:

```json
{
  "mcpServers": {
    "lumibase": {
      "command": "npx",
      "args": ["-y", "@lumibase/mcp-server"],
      "env": {
        "LUMIBASE_URL": "https://api.mysite.lumibase.dev",
        "LUMIBASE_SITE_ID": "site_abc123",
        "LUMIBASE_TOKEN": "<token>"
      }
    }
  }
}
```

A ready-made snippet lives in the monorepo at [`docs/en/agent-setup/mcp-config.json`](https://github.com/khuepm/lumibase/blob/main/docs/en/agent-setup/mcp-config.json).

## What tools are available

Fixed CRUD + read-only groups registered by the stdio server, including:

- **Collections / fields / items** — list, get, create, update, delete, schema diff/apply
- **Insights** — dashboards, panels, ad-hoc aggregate queries (read-only)
- **Editorial** — reviews, approve/reject
- **Releases** — create, update, publish
- **Deployments** — read-only targets, deployments, logs
- **Shares, translation memory, presets, flows, site**

The token's roles are the permission floor: the MCP client can never do more than that same token can through the REST API.

> LumiBase also exposes a **governed HTTP MCP endpoint** at `POST /api/v1/mcp` inside the CMS (feature-flagged). That path runs through the agent harness (HITL, autonomy, veto). This package is the **standalone stdio** server for local editor integration — a passthrough, not the harness.

## Docs

- [MCP overview](https://docs.lumibase.dev/en/mcp/)
- [Agent setup](https://docs.lumibase.dev/en/agent-setup/)

## Related packages

| Package | Role |
| --- | --- |
| [`@lumibase/sdk`](https://www.npmjs.com/package/@lumibase/sdk) | Typed REST / realtime client |
| [`@lumibase/extension-sdk`](https://www.npmjs.com/package/@lumibase/extension-sdk) | Author extensions |
| [`@lumibase/contracts`](https://www.npmjs.com/package/@lumibase/contracts) | Shared Zod schemas / policy & field DSLs |

## License

Apache-2.0 — part of the [LumiBase](https://github.com/khuepm/lumibase) monorepo.
