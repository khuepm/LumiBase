---
version: 3
lastUpdated: 2026-09-20T15:17:02.147Z
sourceLang: vi
translatedFrom: vi
sourceHash: 063a0e0360646e91
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-09-20T15:17:02.147Z
codeVerifiedHash: 063a0e0360646e91
codeVerifiedClaims: 24
---

# Governed tool contract — one contract for both MCP transports

> LumiBase has two MCP surfaces (see [`index.md`](index.md)). Before #454 they did **not** share a contract: the same logical operation could be governed on one surface and ungoverned on the other, and the schema advertised to clients did not describe what the server actually accepted. This page records the contract after they were unified.

## TL;DR

| Aspect | Before | Now |
|---|---|---|
| Schema advertised on `tools/list` | `{type:'object'}` for every skill that did not hand-write one | Derived from the canonical Zod in `@lumibase/contracts` |
| Input validation | None — bad arguments reached the service | Refused **before** any side effect, with code `VALIDATION` |
| Write gate | Only for skills classified `dangerous` | Every skill with a write capability goes through autonomy resolution |
| Caller capabilities | `auth.roles` (a role **id**, compared as a string) | Resolved from the RBAC bundle, like REST |
| stdio mutation result | A self-authored claim ("deleted") | Reflects `executed` / `pending_approval` / `denied` |
| stdio mutations | Direct REST calls, bypassing the harness | 27 tools go through the harness; the rest are **declared** ungoverned |

## 1. One schema source

`packages/contracts/src/agent-tools/schemas.ts` is the canonical source. One Zod definition, two consumers:

- the harness validates `args` against it (`validateAgentToolInput`);
- `tools/list` advertises the JSON Schema derived from the same definition (`jsonSchemaFor`, via `z.toJSONSchema`).

Three rules when adding a schema:

1. **Declare only fields the handler actually reads.** Advertising more than the handler honours is promising a contract that is not kept.
2. **`.strict()`** — unknown fields are **rejected**, not dropped silently. That silent drop is exactly what the old `update_item` did: REST stripped keys outside the `data` envelope and returned `200 OK` with an empty patch.
3. **Keep the key names the handler reads.** Renaming belongs in an alias mapping layer, not in the schema.

A skill without a schema is **not** validated — a deliberate fail-open, so existing read behaviour is not broken by a contract nobody has written yet. `agentToolNamesWithSchema()` returns the covered set.

A hand-written `inputSchema` on a skill **wins**: those were authored against the handler and some describe shapes the canonical set does not cover yet.

## 2. Check order inside `execute()`

The order is part of the contract, not an implementation detail. Each step is where it is for a specific reason:

1. **Kill switch** — a frozen site/role produces nothing at all.
2. **Input validation** — **before `ensureRun`**. Placing it later leaves a `running` run and a `running` tool call behind for input that can never execute. Invalid input means **nothing is written**, and the caller gets `denied` plus `code: 'VALIDATION'` naming the offending field.
3. **`ensureRun` + `appendToolCall`** — from here on everything is audited.
4. **Capabilities** — see section 4.
5. **Tool policy** (per-site risk/rate from `agent_tools`).
6. **Write budget** (per-intent `maxWritesPerMinute`).
7. **Risk + autonomy** — see section 3.

## 3. The write gate does not depend on the `dangerous` classification

`AutonomyService` defines the levels itself: **L0** = no side effects, **L1** = every action creates an approval, **L2** = safe actions execute while dangerous ones await approval, **L3** = veto window, **L4** = autopilot.

The trust gradient used to be reachable only through the `isDangerous` branch, so a plain content write (`createItem`, capability `items:write`) fell straight through to "safe skill — execute directly": an intent capped at L0 still wrote, and L1 never asked for approval. Now:

| Level | Write skill (not control-plane) | Control-plane skill |
|---|---|---|
| L0 | `denied`, `code: 'AUTONOMY_SHADOW'` — no write, and **not** turned into an approval either | approval |
| L1 | approval (same rows, same ids, same decide endpoint) | approval |
| L2 | executes | approval |
| L3 | executes | staging + veto window (when the flag is on) |
| L4 | executes | executes |

**Backward compatibility:** `resolveAutonomy` defaults to **L2** for a safe capability when no grant exists. An installation that never configured autonomy behaves **exactly as before**; the gate only bites once someone has lowered the level explicitly (a grant row, or an intent's `autonomyCap`).

**Reads are untouched:** the gate keys off capabilities matching `:(write|update|create|delete)$`.

## 4. Capabilities come from RBAC, not from `auth.roles`

`withAuth` sets `auth.roles` to a role **id** for a normal user (`role_7fK…`), `[]` for an API key, and the literal `'admin'` only for bootstrap/dev. Compared by exact string against `items:write`, a role id can never match — so the gate was effectively **admin-or-nothing**, and a site admin holding a real `adminAccess` role (rather than being the bootstrap user) was refused.

Every transport now calls one resolver (`services/governed-capabilities.ts`) backed by the compiled RBAC bundle:

| Permission in the bundle | Capability derived |
|---|---|
| bundle `admin` | `['admin']` (not `*`) |
| `read` on a collection | `items:read` |
| `create` | `items:create`, `items:write` |
| `update` | `items:update`, `items:write` |
| `delete` | `items:delete`, `items:write` |
| collection `schema`, action `schema:*` | that action verbatim |
| any other domain | **omitted**, never guessed |

A consequence worth stating: because only `items:*` and `schema:*` are derived for non-admins, every control-plane skill (`access:*`, `config:*`, `flows:*`, `intents:*`, `cdc:manage`, `deployments:*`, `users:*`, `teams:*`, `api-keys:*`, `extensions:*`) is in practice **admin-only**. That is the fail-closed state: opening one to non-admins means adding a pseudo-resource to the `permissions` table and extending the table above — not loosening `checkCapabilities`.

**Fail-closed in two layers:** a request with no identifiable principal (anonymous) resolves to no capabilities. A resolution that fails (database down) resolves to `denied` — it does **not** throw out of the route and does **not** fall back to something permissive.

**Queued work and approvals** carry an `AuthenticatedPrincipalRef` — an identity reference, **not** a capability snapshot — and the worker re-resolves when it picks the job up. A revoked key or a demoted user therefore takes effect on work that was already accepted.

**An approved action executes with `requester ∩ decider`.** Both sides are re-read at the moment of approval, and both must still allow it. `agent_approvals.requested_by_principal` stores who asked — as a reference, never a capability snapshot — so a requester who was demoted, whose API key was revoked or who lost site membership while the approval waited cannot have their action executed. Using the decider alone would let a revoked requester act; using the requester alone would let an approval widen what the decider may do.

The recorded requester is one of two shapes, because not every requester is a person:

```jsonc
{ "kind": "principal", "ref": { "type": "user",    "siteId": "…", "userId": "…" } }
{ "kind": "principal", "ref": { "type": "api_key", "siteId": "…", "apiKeyId": "…" } }
{ "kind": "agentRole", "role": "translator", "intentId": "…", "autonomyCap": 2 }
```

Reconciler-origin work has no human principal: the intent that declared the rule is the authority and the agent role is the capability boundary, so disabling that role also stops anything it had parked.

**Fail-closed on missing provenance.** An approval parked before this column existed cannot be resolved, and is refused with `APPROVAL_PROVENANCE_MISSING` rather than falling back to the decider's rights — that fallback is the behaviour this replaces. Those approvals must be re-requested after upgrading; the migration header names the query that lists them. Denial codes: `APPROVAL_PROVENANCE_MISSING`, `APPROVAL_PROVENANCE_INVALID`, `REQUESTER_REVOKED`, `REQUESTER_ROLE_UNAVAILABLE`, `REQUESTER_RESOLUTION_FAILED`.

Row and field scoping is not part of this set: it stays in `ItemService`, built from the requester's permission context rather than a system one.

## 5. The decision contract and the two approval id spaces

`tools/call` returns the decision **inside** the tool result, never as a protocol error:

```jsonc
{
  "status": "executed" | "pending_approval" | "denied",
  "code": "VALIDATION | AUTONOMY_SHADOW | …",
  "data": {},
  "approvalId": "…",
  "approvalSpace": "agent" | "legacy_ai",
  "agentApprovalId": "…",
  "legacyApprovalId": "…",
  "runId": "…",
  "message": "…"
}
```

`code` appears only when `denied`; `data` only when `executed`; the `approval*` group only when `pending_approval`.

`isError` equals `status === 'denied'`.

Two id spaces exist and they are **not** interchangeable — `execute()` inserts into **both** tables, and they are decided at two different endpoints:

| `approvalSpace` | Table | Decide endpoint |
|---|---|---|
| `agent` | `lumibase_agent_approvals` | `POST /api/v1/agent/approvals/{approvalId}/decide` |
| `legacy_ai` | `lumibase_ai_approvals` | `POST /api/v1/ai/approvals/{approvalId}/decide` |

The contract used to collapse `agentApprovalId ?? approvalId` into one field, so a client held a valid-looking id with no way to know which table it belonged to. `approvalId` keeps its historical meaning (agent preferred) so existing clients are unaffected; `approvalSpace` is the additive part that states it.

## 6. stdio: which tools are governed

`packages/mcp-server/src/governed.ts` holds two tables.

**`GOVERNED_TOOLS` (27 tools)** — routed through `POST /api/v1/mcp` `tools/call`. The set was **measured**, not chosen by feel: for each candidate tool, the advertised properties (minus `confirm`) were compared against the canonical contract's properties, and a tool is accepted only when it has no extra property and no unreachable required one. Three tools need an explicit rename:

| Tool | Skill | Rename |
|---|---|---|
| `delete_field` | `deleteField` | `field_name` → `name` (plus `force`, see below) |
| `add_team_member` | `addTeamMember` | `id` → `teamId` |
| `remove_team_member` | `removeTeamMember` | `id` → `teamId` |

`confirm` is a prompt for the operator, not a skill argument, so it is **dropped** rather than forwarded.

`force` on `delete_field` is the opposite case and **is** forwarded: `SchemaService.deleteField` accepts `FieldDeleteOptions.force` and REST passes `?force=true`, so a governed path unable to express it would be the one place that rejects an argument REST accepts. The rule: declare what the handler honours, drop what only the operator needs. That boundary is now recomputed from the registry on every test run by `governed-binding-contract.test.ts` — it had been measured once by a script and then hand-edited, which is how `force` was missed.

**`UNGOVERNED_MUTATIONS`** — still REST, each with its reason:

| Reason | Meaning |
|---|---|
| `contract-narrower-than-tool` | A skill exists, but the canonical contract is narrower than the surface the tool advertises. Routing it would **reject** arguments callers legitimately send today, and dropping them silently is the very class of bug being fixed. Example: `create_collection` has 16 extra properties |
| `no-canonical-contract` | A skill exists but has no canonical schema yet, so there is nothing to validate against |
| `no-skill` | No corresponding skill — nothing to route to |

This is a **declared** gap, not a hidden one. Tripwire `S16` fails when a mutation tool appears in neither table, so the set cannot grow quietly.

### Modes

`LUMIBASE_MCP_GOVERNED`:

| Value | Behaviour |
|---|---|
| `auto` (default) | Probe once. Use governance when the site has it; otherwise fall back to REST with **one** stderr warning. Unmapped mutations stay on REST |
| `on` / `true` / `1` | **Refuse** instead of falling back — and also refuse any mutation that has no governed mapping at all. The right value for a deployment that requires governance |
| `off` / `false` / `0` | Keep the pre-#454 behaviour |

The default is `auto` because `contentOs.mcp` also defaults **off** — defaulting to `on` would break every existing install on upgrade.

`auto` is a convenience, **not** a security property: the fallback it performs is announced, but a deployment that must not execute ungoverned writes has to set `on`. The reason is simple: a fallback that triggers exactly when governance is unavailable is a bypass of governance.

**Mode `on` refuses unmapped mutations too.** Declaring a gap in `UNGOVERNED_MUTATIONS` documents it; it does not close it. The registration wrapper previously replaced a handler only when a governed mapping existed, so in `on` — the setting whose entire purpose is "never execute an ungoverned write" — the 27 mapped tools were governed and the other mutations still went straight to REST. `update_collection` reached `PATCH /collections/:name` and reported success with zero JSON-RPC calls.

In `on`, a mutation without a mapping now returns an error naming its reason, and **no REST call is issued** — the refusal replaces the call rather than following it. A mutation in neither table is refused as well, so a tool added without a governance decision fails safe at runtime even if CI missed it. Read-only tools are unaffected: refusing those would break the transport for no safety gain. Classification uses `isMutationTool` in `governed.ts`, which is the same function the inventory tripwire uses — one definition, so the gate and the tripwire cannot disagree.

Note: the warning goes to **stderr**. stdout is the MCP transport, and writing there corrupts the protocol stream.

## 7. Sources of truth

| Aspect | File |
|---|---|
| Canonical schemas | `packages/contracts/src/agent-tools/schemas.ts` |
| Validation + autonomy gate + approval parking | `apps/cms/src/services/ai-harness.ts` |
| Decision contract + approval id spaces | `apps/cms/src/services/mcp-service.ts` |
| Capability resolution | `apps/cms/src/services/governed-capabilities.ts`, `effective-capability-service.ts` |
| Governed/ungoverned tables + modes | `packages/mcp-server/src/governed.ts` |
| stdio decision rendering | `packages/mcp-server/src/tools/_shared.ts` |
