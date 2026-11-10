# `@lumibase/mcp-server`

Stdio [Model Context Protocol](https://modelcontextprotocol.io) server for [LumiBase](https://lumibase.dev). Lets AI assistants (Claude Code, Cursor, Windsurf, …) manage collections, fields, items, editorial workflow, releases, insights, and more against a running CMS through REST and governed MCP endpoints.

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
| `LUMIBASE_SITE_ID` | Except unpinned `lbo_` | `site_abc123` |
| `LUMIBASE_TOKEN` | Yes | Bearer token with the roles you want the agent to inherit |
| `LUMIBASE_READ_ONLY` | No | `true` hides mutation tools; default `false` |

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
        "LUMIBASE_TOKEN": "<token>",
        "LUMIBASE_READ_ONLY": "true"
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

### Organization keys

Unpinned organization configuration (read-only by default):

```json
{
  "mcpServers": {
    "lumibase-organization": {
      "command": "npx",
      "args": [
        "-y",
        "@lumibase/mcp-server"
      ],
      "env": {
        "LUMIBASE_URL": "http://localhost:1989",
        "LUMIBASE_TOKEN": "lbo_<organization-key>",
        "LUMIBASE_READ_ONLY": "true"
      }
    }
  }
}
```

Set `LUMIBASE_READ_ONLY=false` when you want to request writes; enable organization MCP and approve the resulting requests in Studio.

With an `lbo_` key, omit `LUMIBASE_SITE_ID` to expose eight organization tools plus the site tools. Each site tool then requires a `site` argument. Pin a site to expose the original site tools plus `get_organization` and `list_sites`; an `lbk_` key keeps the original site tool list. Site headers are isolated per call.

Organization mutations always use governed HTTP MCP, even when `LUMIBASE_MCP_GOVERNED=off`. Enable `settings.contentOs.mcp.allowOrganizationTools` on the organization; `LUMIBASE_MCP_ORG_TOOLS=off` disables it globally. Every organization mutation requires human approval. `confirm` acknowledges intent and cannot bypass approval. A new organization key is available only in the human approval receipt, never in the agent response. Owners/admins use `/api/v1/orgs/:orgId/approvals/:approvalId/decide` with `{"decision":"approved"}` or `rejected`; API keys cannot read receipts or decide. The requesting principal is checked again at approval time.

> LumiBase also exposes a **governed HTTP MCP endpoint** at `POST /api/v1/mcp` inside the CMS (feature-flagged). That path runs through the agent harness (HITL, autonomy, veto). This package is the **standalone stdio** server for local editor integration — site tools support governed dispatch; organization mutations always enter the organization harness.

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
