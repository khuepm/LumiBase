---
version: 12
lastUpdated: 2026-11-10T07:50:45.521Z
sourceLang: vi
translatedFrom: vi
sourceHash: 2617d4d07e4ede6f
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-11-10T07:50:45.521Z
codeVerifiedHash: 2617d4d07e4ede6f
codeVerifiedClaims: 28
---

# Model Context Protocol (MCP) — LumiBase

> The central docs source for LumiBase's MCP capability. This document describes the **actual current state** in the codebase (verified against `apps/cms/src/routes/mcp.ts`, `apps/cms/src/services/mcp-service.ts`, `packages/mcp-server/`) and is the place to come back to when analysing how MCP should apply to future features.

## TL;DR

LumiBase exposes **two MCP surfaces**. Governed site tools use the same site harness as the Agent API (the "MCP parity" invariant, Property 14). Organization tools use the organization harness and its human approval boundary:

| Surface | Transport | Location | Used for |
|---|---|---|---|
| **HTTP endpoint** | Streamable HTTP (JSON-RPC 2.0, POST/response, no SSE) | `POST /api/v1/mcp` (`apps/cms/src/routes/mcp.ts`) | Remote MCP clients; dynamic tools from the tool registry; subject to every harness guard |
| **Standalone server** | Stdio (stdin/stdout) | `packages/mcp-server/` (`bin: lumibase-mcp`) | Local editor integration (Claude Code, Cursor, Windsurf); a fixed set of CRUD tools |

## 1. The HTTP MCP endpoint — `POST /api/v1/mcp`

Source: [`apps/cms/src/routes/mcp.ts`](../../../apps/cms/src/routes/mcp.ts), [`apps/cms/src/services/mcp-service.ts`](../../../apps/cms/src/services/mcp-service.ts).

- **Transport:** Streamable HTTP — JSON-RPC 2.0, one request/one response. `GET /api/v1/mcp` returns `405 METHOD_NOT_ALLOWED` (there is no server-initiated stream/SSE); clients fall back to plain request/response per the MCP spec.
- **Protocol versions:** `2025-06-18` (default) and `2025-03-26`. `serverInfo = { name: 'lumibase-mcp', version: '1.0.0' }`.
- **Auth → capability:** Bearer token; the capability set is **resolved from the token's live RBAC bundle** (#472), not from `auth.roles`. ⇒ an MCP client can **never do more** than that same token can through REST — and never less either, which is what reading `auth.roles` got wrong (a role id can never match `items:write`). See [`governed-tool-contract.md`](governed-tool-contract.md) section 4.
- **Feature gate:** the per-site `contentOs.mcp` flag (default **off**). Off → `404 MCP_DISABLED`. (`feature-flags.ts`).
- **Methods (JSON-RPC):**
  - `initialize` — negotiates the protocol version, returns `capabilities: { tools: { listChanged: false } }`.
  - `ping`.
  - `tools/list` — lists the **currently enabled** tools from `ToolRegistryService`; the inputSchema is derived from the canonical schemas in `@lumibase/contracts` (only a skill with no schema still falls back to `{ type: 'object' }`).
  - `tools/call` — runs through `AISecureHarness.execute(skillName, args, capabilities, contextMessage)`. The result is wrapped as `{ content, structuredContent, isError }`.
  - `notifications/initialized`, `notifications/cancelled` → return `null` ⇒ HTTP `202 Accepted` with no body.
- **Mapping decision → tool result** (an important invariant):
  - `executed` → `isError: false`, data in `structuredContent`.
  - `pending_approval` → `isError: false`, with **`approvalId` inside `structuredContent`**; this is NOT a protocol error.
  - `denied` → `isError: true`.
  - Protocol errors are reserved for genuine JSON-RPC failures: `-32700` parse, `-32600` invalid request, `-32601` method not found, `-32602` invalid params.
- **Guards inherited from the harness** (zero MCP-specific logic): kill switch, capability, autonomy (L0–L4), constitution pin, load guard, veto window. See [`docs/en/features/agent-harness-layer.md`](../features/agent-harness-layer.md).

### The tool registry (dynamic)

Source: [`apps/cms/src/services/tool-registry-service.ts`](../../../apps/cms/src/services/tool-registry-service.ts), the `agentTools` table (`packages/database/src/schema/ai.ts`).

- The registry **merges** core skills (from the harness `CORE_SKILLS`) with DB overrides (`agentTools`, per site).
- Each `AgentToolDefinition` carries: `inputSchema`, `outputSchema`, `riskPolicy.level` (`safe | review_required | dangerous | blocked`), `rateLimit` (per-minute, per-run), `enabled`, `owner` (`core | db | …`), `extensionId?`.
- `coreTool()` sets `risk = dangerous` if the skill mutates the schema or its name starts with `delete`.
- `evaluatePolicy(tool, runId)` checks enabled/blocked plus the rate limit.
- Audit: `agentToolCalls` (input/output/error/status/approvalId/cost/latency); approvals: `agentApprovals`.

## 2. The standalone MCP server — `@lumibase/mcp-server`

Source: [`packages/mcp-server/`](../../../packages/mcp-server/) (built on `@modelcontextprotocol/sdk`; the version lives in that package's own `package.json` and is deliberately not pinned here, to avoid adding another place that can drift).

- **Transport:** Stdio (`StdioServerTransport`). Intended for local editor integration.
- **Entry:** `packages/mcp-server/src/index.ts` — `new McpServer({ name: 'lumibase', ... })`, registers the collection/field/item tools, then `connect(StdioServerTransport)`.
- **Client:** `LumiBaseClient` — HTTP to `/api/v1` with a Bearer token + site header.
- **Config:** [`docs/en/agent-setup/mcp-config.json`](../agent-setup/mcp-config.json) — env `LUMIBASE_URL`, `LUMIBASE_SITE_ID`, `LUMIBASE_TOKEN`.
- **Studio:** the *Data model → Set up MCP for your IDE* page (`/data-model/mcp-setup`) creates a dedicated role-scoped API key, generates the Cursor/Claude Desktop/VS Code config, and has a **Try these prompts** section — copy-ready starter prompts grouped as Explore/Content/Schema/Operations and labelled `Read-only`/`Writes data`/`Admin role`. The list lives in [`apps/studio/src/modules/data-model/mcp-prompts.ts`](../../../apps/studio/src/modules/data-model/mcp-prompts.ts); each prompt declares the tools it uses and a test checks them against the tools the server actually registers.


### Organization credentials (ADR-013)

Example for an unpinned organization key. Keep the sample read-only; set `LUMIBASE_READ_ONLY=false` to request writes, enable organization MCP in Settings, and approve requests as a human.

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



Set `LUMIBASE_READ_ONLY=true` to publish only tools annotated as read-only. The client also refuses any non-GET request in this mode except a fixed list of preview/query endpoints (schema diff, translation-memory lookup, insight panels, permission and access checks, intent compile), so a tool cannot write even if its name looks like a read. With an `lbk_` key, `LUMIBASE_SITE_ID` remains required and the existing site tool list is unchanged. With an `lbo_` key, omit the site to expose eight organization tools (`get_organization`, `list_sites`, `create_site`, `delete_site`, `transfer_site`, `list_org_members`, `invite_org_member`, `create_org_key`) plus site tools requiring a `site` argument. Pinning a site exposes the original site tools and the first two organization reads. Parallel calls cannot share site headers.

Organization writes always use the governed HTTP endpoint, including when `LUMIBASE_MCP_GOVERNED=off`; there is no REST fallback. Enable organization setting `contentOs.mcp.allowOrganizationTools`; global `LUMIBASE_MCP_ORG_TOOLS=off` overrides it. Every organization mutation waits for human approval. The `confirm` argument is an acknowledgement, not an approval. An owner/admin reads `/api/v1/orgs/:orgId/approvals`, opens `/:approvalId`, and posts `{"decision":"approved"}` or `{"decision":"rejected"}` to `/:approvalId/decide`. Owner-only operations still require an owner; transfers require the same human owner in both organizations. API keys cannot decide or read receipts. New organization key plaintext appears only in the human receipt. The requester must still hold live authority when approved; execution and the receipt commit atomically. Organization approvals use a real organization parent (migration `0025`), including organizations with zero sites.

### The fixed tools (CRUD + read-only insights)

| Group | Tools |
|---|---|
| Collections (7) | `list_collections`, `get_collection`, `create_collection`, `update_collection`, `delete_collection`, `diff_schema`, `apply_schema` |
| Fields (3) | `list_fields`, `upsert_field`, `delete_field` |
| Items (5) | `list_items`, `get_item`, `create_item`, `update_item`, `delete_item` |
| Insights (5, read-only) | `list_dashboards`, `get_dashboard`, `list_dashboard_panels`, `run_panel`, `query_insights` |
| Editorial (4) | `list_reviews`, `submit_review`, `approve_content`, `reject_content` |
| Releases (6) | `list_releases`, `get_release`, `create_release`, `update_release`, `publish_release`, `delete_release` |
| Deployments (4, read-only) | `list_deployment_targets`, `list_deployments`, `get_deployment`, `get_deployment_logs` |
| Shares (2) | `create_share`, `revoke_share` |
| TM / presets / misc | `list_tm`/`lookup_tm`/`translate_text`/`upsert_tm`/`update_tm`/`delete_tm`, `get_effective_preset`, `list_preset_bookmarks`, `list_transform_presets`, `get_flow_run`, `get_site` |

> **Insights (Wave 1 — [`mcp-application-analysis.md`](mcp-application-analysis.md)):** a read-only group letting an agent "ask about the numbers" — run a saved panel or an ad-hoc aggregate query (`query_insights`, the highest-value tool). It does not mutate, it carries the token's read permission, and it does not enter HITL; aggregation is field-whitelisted and capped server-side by `InsightsService`. The table above illustrates the main groups; the source of truth is [`packages/mcp-server/src/tools/`](../../../packages/mcp-server/src/tools/).

### Deliberately NOT on MCP (intentional exclusions)

These are not oversights — each has a reason:

| Surface | Why it is excluded |
|---|---|
| `/realtime` (SSE/WS) | MCP is request/response; no streaming. Agents use `cdc_events_read` to poll. |
| Signed media delivery URLs | Signed URLs are built at the edge with a server secret; no REST endpoint returns one. `/files/presigned-url` is upload-only. |
| Binary `/files`, `/uploads` | Binary up/download streams at the edge — a poor fit for a text tool. |
| Triggering a deploy | A side effect on an external host → **dangerous**; only in the governed `triggerDeployment` skill (HITL). Stdio carries the read side only. |
| `/admin/encryption`·`/admin/sar`·`/admin/erasure`·`/retention`·`/scim-tokens` | Sensitive security/GDPR/enterprise admin — the crypto/SSRF/PII logic lives in REST, not in a passthrough. |
| `/auth`, `/me/*` | Human auth/session and self-service, not content ops. |
| `/typegen`·`/domains`·`/integrations/git`·`/firebase-sync`·`/push` | Dev/infra tooling, low agent value. |

## 2b. Content versions over MCP (Wave 2 — governed harness skills)

Versioning is **not** in the stdio server. It is exposed as **governed skills** flowing through `AISecureHarness` (`POST /api/v1/mcp` → `tools/list`/`tools/call`), because `promoteVersion` overwrites main and **must go through HITL** — something a stdio passthrough cannot do.

| Skill | Capability | Risk | Note |
|---|---|---|---|
| `listVersions` | `items:read` | safe | Lists an item's version branches (including the `mainChanged` flag). |
| `compareVersion` | `items:read` | safe | Compares a branch with main (field-level changes). |
| `createVersion` | `items:write` | **dangerous** | Snapshots the current data into a new branch. |
| `updateVersion` | `items:write` | **dangerous** | Edits a branch's draft/name. |
| `deleteVersion` | `items:write` | **dangerous** | Deletes a branch (leaves main alone); dangerous via the `delete` prefix. |
| `promoteVersion` | `items:write` | **dangerous** | Applies a branch to main via `ItemService.patch` (writes a revision + invalidates cache), then deletes the branch; returns `mainDiverged`. |

- **Source:** handlers in [`apps/cms/src/services/ai-harness.ts`](../../../apps/cms/src/services/ai-harness.ts) (`buildCoreSkills` → `ContentVersionService`); the public definitions in [`packages/ai-skills/src/skills.ts`](../../../packages/ai-skills/src/skills.ts). The two places **must carry the same key set** (test `governed-skills.test.ts`).
- **Risk:** `createVersion`/`updateVersion`/`promoteVersion` set the `dangerous` flag; `deleteVersion` is dangerous via its name prefix. `ToolRegistryService.coreTool` → `riskPolicy.level = 'dangerous'`, `approvalPolicy = 'before_execute'`.
- **`promoteVersion` is not irreversible:** it writes a revision, so it is recoverable → it is **not** hard-capped at L2 the way schema drops are; it stays `dangerous` (HITL at ≤L2 by default, until the role earns higher autonomy).

## 3. Established invariants & boundaries

- **MCP parity (Property 14):** a `tools/call` decision matches a direct harness decision **byte for byte**. Test: [`apps/cms/src/services/__tests__/mcp-parity.property.test.ts`](../../../apps/cms/src/services/__tests__/mcp-parity.property.test.ts).
- **No separate `mcp_servers`/`mcp_sessions` tables** — MCP reuses the agent infrastructure (approvals, tool calls, permissions). This is a deliberate architectural decision (zero MCP-specific state).
- **The SDK has no MCP client** — MCP is not a concern of the REST SDK's clients.
- **Permission floor:** capability = the token's RBAC bundle (one model shared with REST). Every MCP extension must respect this floor.
- **Governed tool contract:** schemas, validation, the write gate, the decision shape, and which stdio tools are governed all live in [`governed-tool-contract.md`](governed-tool-contract.md).

## 4. Related pages

- [`governed-tool-contract.md`](governed-tool-contract.md) — the contract shared by both transports: schema source, validation order, autonomy gate, decision shape, and which stdio tools are governed.
- [`mcp-application-analysis.md`](mcp-application-analysis.md) — analysis of how MCP applies to the 7 Directus-inspired specs.
- [`docs/en/agent-setup/claude-code.md`](../agent-setup/claude-code.md) — how to wire the MCP server into Claude Code.
- [`docs/en/features/agent-harness-layer.md`](../features/agent-harness-layer.md) — the harness guards MCP inherits.

## 5. Sources of truth (update these when the code changes)

| Aspect | File |
|---|---|
| HTTP endpoint + gating | `apps/cms/src/routes/mcp.ts` |
| JSON-RPC adapter + protocol versions | `apps/cms/src/services/mcp-service.ts` |
| Tool registry + risk/rate policy | `apps/cms/src/services/tool-registry-service.ts` |
| Agent tables (tools/calls/approvals) | `packages/database/src/schema/ai.ts` |
| Standalone server + its tools | `packages/mcp-server/src/` |
| The `contentOs.mcp` feature flag | `apps/cms/src/services/feature-flags.ts` |
| Parity test | `apps/cms/src/services/__tests__/mcp-parity.property.test.ts` |
