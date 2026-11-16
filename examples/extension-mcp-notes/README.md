# MCP Notes Extension (#715)

An extension that adds **governed MCP tools**, a **prompt** and a **resource**.

- `manifest.json` → `mcp` block: what is listed and what an admin reviews. Generate it from the
  same definitions with `mcpManifest()` from `@lumibase/extension-sdk`.
- `src/index.ts` → the bundle; the host reads only `mcp.tools[].handler` from it.

Install it, then grant `mcp:tools`, `mcp:prompts` and `mcp:resources` on the installed row
(plus the item capabilities the handlers use). The tools appear as
`ext_mcp_notes__countNotes`, `ext_mcp_notes__appendNote`, `ext_mcp_notes__addNotesField` on
`POST /api/v1/mcp` and on the stdio `@lumibase/mcp-server`, and run through the same harness as
every other tool:

| Tool | riskClass | What happens |
|---|---|---|
| `countNotes` | `read_only` | runs when the caller holds `items:read` |
| `appendNote` | `low` | runs autonomously from autonomy L2; parks for approval at L1 |
| `addNotesField` | `medium` → **high** | `schema:write`: every call waits for a signed-in human |

See `docs/en/features/extensions-system.md` §9.
