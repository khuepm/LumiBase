---
version: 2
lastUpdated: 2026-11-15T12:16:36.578Z
sourceLang: en
contentHash: f546435ef3f2214a
codeVerified: 2026-11-15T12:16:36.578Z
codeVerifiedHash: f546435ef3f2214a
codeVerifiedClaims: 24
---

# External-action tools

Every built-in agent skill acts on content, schema or configuration that LumiBase
stores. An **external-action tool** is an agent tool whose effect lands somewhere
else: it calls an API outside the CMS. The harness cannot see what such a call
changed and cannot undo it, so the tool declares what the harness would otherwise
have to guess, and the harness decides on that declaration.

LumiBase ships the mechanism and one reference tool for tests. It registers no
external-action tool itself.

Source: `apps/cms/src/services/external-action-tools.ts` (declaration, registry,
decision rule), `apps/cms/src/services/ai-harness.ts` (decision and execution),
`apps/cms/src/services/tool-secret-service.ts` (secrets),
`apps/cms/src/services/external-action-audit.ts` (audit rows),
`apps/cms/src/services/external-action-policy.ts` (pre-execution policy).

## What a tool declares

```ts
import { externalActionTools } from './services/external-action-tools';

externalActionTools.register({
  name: 'ticketComment',
  description: 'Adds a comment to a ticket in the tracker.',
  capability: 'tickets:comment',
  risk: 'medium',
  reversibility: 'reversible',
  blastRadius: { scope: 'single' },
  secrets: ['TRACKER_API_TOKEN'],
  inputSchema: {
    type: 'object',
    properties: {
      ticket: { type: 'string', maxLength: 64 },
      body: { type: 'string', maxLength: 4000 },
    },
    required: ['ticket', 'body'],
  },
  handler: async (args, context) => {
    const token = context.secret('TRACKER_API_TOKEN');
    // call the tracker with `token`; return a result without it
    return { ok: true };
  },
});
```

| Field | Values | Meaning |
|---|---|---|
| `capability` | `namespace:action` | The one capability a caller must hold. `*` and `admin` are not valid declarations |
| `risk` | `low`, `medium`, `high` | How bad a wrong call is |
| `reversibility` | `read_only`, `reversible`, `irreversible` | Whether the effect can be undone by a later call |
| `blastRadius` | `none`, `single`, `bounded` (with `maxAffected`), `broad` | How many external parties one call can reach |
| `secrets` | names matching `^[A-Z][A-Z0-9_]{1,63}$` | The secrets the handler needs, by reference |
| `inputSchema` | JSON Schema, `type: "object"` | The arguments; enforced before a run or an approval exists |
| `policy` | optional, see [Pre-execution policy](#pre-execution-policy) | Whether the site's constitution is evaluated before the tool runs |

Registration refuses a declaration that contradicts itself: a `read_only` tool
must declare `blastRadius.scope: "none"`, a tool with an effect cannot declare
`none`, and a `broad` blast radius must be declared `high` risk. A tool cannot
take the name of a built-in skill.

Role policies express content and schema permissions, so today a capability
such as `tickets:comment` is held only by a principal with administrative
access. An agent role narrows that to the capabilities the role lists
(`role ∩ caller`), which is how an agent gets a tool without the rest of the
administrator's reach.

The registry is in memory and process-wide, because a tool is code. What is per
site is everything that decides whether a call may run: the caller's
capabilities, the autonomy grant, the `agent_tools` override row (it can disable
or rate-limit a tool for one site) and the tool's secrets.

## How a call is decided

An external-action tool passes the same gates as every tool call, in the same
order: kill switch, input validation, capability, tool policy. The risk step is
then taken from the declaration (`governanceFor`):

| Declaration | L0 | L1 | L2 | L3 | L4 |
|---|---|---|---|---|---|
| `read_only` | runs on capability alone; not on the autonomy gradient |||||
| `high` risk, or `irreversible` | denied | approval | approval | approval | approval |
| `medium` risk, reversible | denied | approval | approval | approval | runs |
| `low` risk, reversible | denied | approval | runs | runs | runs |

- A high-risk or irreversible tool **always** waits for an approval. No autonomy
  grant, intent cap or `agent_tools` override changes that.
- With no autonomy grant for `(agent role, capability)`, the level is **L1**: an
  external effect is never autonomous because nobody configured a grant.
- L3 does not stage an external action into a veto window. Staging exists for
  content patches, which can be reverted; an external call cannot.
- A tool only runs through the governed path. `runSkill` called directly and a
  harness without run auditing both refuse it with `EXTERNAL_TOOL_UNGOVERNED`.

### Who may approve

An approval parked for an external-action tool is stored with
`approvalPolicy: "human_required"` and can only be released by a **signed-in
user**. The following are refused with `HUMAN_APPROVAL_REQUIRED`, whatever their
capabilities:

- an API key, including an organization key;
- an OAuth access token issued to an MCP connector;
- the agent reviewer (`POST /api/v1/agent/approvals/:id/agent-decide`), also when
  `contentOs.agentReview` is on;
- a frontend end-user session;
- a caller that does not state who it is.

The rule is checked against both the tool's current declaration and the policy
stored on the approval, so re-registering the tool with a milder declaration
does not lift it for approvals already parked. Everything else about a decision
is unchanged: it needs `approvals:decide`, it executes with
`requester ∩ decider` capabilities, and a frozen site or role refuses it.

Any principal that may decide approvals can still **reject** one.

## Pre-execution policy

A tool can declare a `policy`. The site's constitution (the versioned evaluator
set described in the Content OS docs) is then evaluated on every call of the
tool, on a flat record describing that call:

```ts
policy: {
  constitution: 'required',               // or 'if_active'
  constitutionHashes: ['sha256:…'],       // optional: the only versions accepted
  record: (args, facts) => ({             // optional: default is the arguments
    body: args.body,
    intentRef: facts.intentId,
  }),
},
```

| Field | Meaning |
|---|---|
| `constitution: 'required'` | The call is refused unless the site has an active constitution. Fail closed |
| `constitution: 'if_active'` | Evaluated when the site has an active constitution; runs without one |
| `constitutionHashes` | The constitution pinned to the run must have one of these hashes. Any other version refuses the call (`CONSTITUTION_NOT_ACCEPTED`) |
| `record(args, facts)` | Builds the record the evaluators read. Rule evaluators read top-level fields only, so keep it flat |

The harness always adds its own facts to the record, after the tool's fields, so
a tool or an argument cannot overwrite them: `tool`, `capability`, `risk`,
`blastRadius` (the scope), `agentName`, `agentRole`, `intentId` and `runId`.

When the evaluation happens:

- **Before anything else is decided about the call.** After the kill switch,
  input validation, capability and tool-policy gates and the L0 check, before an
  approval is parked or the tool runs autonomously.
- **Again before an approved call executes.** If the policy now refuses (the
  constitution was deactivated, or the call now breaks a rule), the approval is
  released back to `pending`, as with a frozen site, and nothing runs.

A run is evaluated against the constitution pinned to it, even after a newer
version is activated. A `required` policy still refuses on a site that has no
active version at all, so deactivating the constitution stops every governed
call, including those of runs already under way.

Outcomes:

| Outcome | What happens | Code |
|---|---|---|
| every blocking evaluator passes | the decision continues as in the table above | none |
| a blocking evaluator fails | refused, at every autonomy level | `CONSTITUTION_VIOLATION` |
| only evaluators with `onViolation: "require_approval"` fail | parked for a human, even where the level would have run it; a `read_only` tool too | none (`pending_approval`) |
| a blocking evaluator errors (bad regex, no LLM for an `llm_judge`) | refused, whatever its `onViolation` | `CONSTITUTION_VIOLATION` |
| `required` and no active constitution | refused; no approval is parked | `CONSTITUTION_REQUIRED` |
| the pinned version is not in `constitutionHashes` | refused | `CONSTITUTION_NOT_ACCEPTED` |
| `record` throws or returns a non-object | refused | `POLICY_RECORD_INVALID` |

`onViolation` is an optional field of an evaluator (`block`, the default, or
`require_approval`). It is part of the constitution and of its hash. The publish
gate treats both values as blocking.

The refusal message names the evaluators that failed, never the call's content:
an `llm_judge` reason can quote the arguments, so it is not returned.

A tool without a `policy` is not evaluated and behaves exactly as before.

## Loading tools from a package

A deployment entry that wraps the CMS can hand over tools from a package outside
this repository through the `externalActions` platform seam, instead of the CMS
importing them:

```ts
import { registerPlatformSeams } from '@lumibase/cms/platform';
import { myTools } from 'my-tools-package';

registerPlatformSeams({
  externalActions: { tools: () => myTools() },
});
```

- `tools()` is called once, inside `registerPlatformSeams()`. Every definition is
  validated and registered into the process-wide registry right there, so the
  harness, `tools/list` and MCP see the same set from the first request.
- All or nothing: if one definition is malformed or a name is taken, none is
  registered and `registerPlatformSeams()` throws. A deployment must not run with
  half its tools.
- The built-in entries (`cloudflare.ts`, `serve.ts`) never register anything:
  without a registration the registry is empty and the skill catalog is the
  built-in one, unchanged.

See [Platform extension points](../architecture/platform-extension-points.md).

## Secrets

A tool names its secrets; an administrator stores the values per site:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/agent/tool-secrets` | Names, key version and timestamps. Never values |
| `PUT` | `/api/v1/agent/tool-secrets/:name` | Body `{ "value": "…" }` (8 to 8192 characters). Stores or replaces |
| `DELETE` | `/api/v1/agent/tool-secrets/:name` | Removes the secret |

All three need a signed-in site administrator. API keys are refused even with
administrative rights: an agent must not be able to plant or swap the secret a
tool will use.

- The value is encrypted with the runtime `KeyProvider` (the same versioned
  envelope as deployment tokens, so key rotation applies) and bound to its site
  and name. No route returns it.
- It is decrypted when the handler is about to run, and exists only in the
  context object the handler receives. It is not part of the arguments, the
  prompt, the tool result, the stored tool call, the run, the approval or the
  audit rows.
- Whatever the handler returns or throws is scrubbed of the resolved values (raw,
  URL-encoded and base64) before it leaves the harness. A leaked value becomes
  `[secret:NAME]`.
- A handler can only read the names its tool declared.
- A secret that is not configured fails the call **before** the handler starts
  (`SECRET_MISSING`, naming the reference). Nothing external happened, so an
  approval in that state returns to `pending` and can be retried once the secret
  is set.

A handler failure after the handler started leaves an unknown amount of work
done. As with every approved action, the approval then stops at `failed` and a
human reopens it after checking what happened.

## Audit

Each step writes one `lumibase_activity` row for the site:

| `action` | When |
|---|---|
| `agent.external_action.proposed` | The call was parked as a pending approval |
| `agent.external_action.approved` | A user released it. Written **before** the handler runs; if this write fails, the handler does not start |
| `agent.external_action.rejected` | A decider rejected it |
| `agent.external_action.refused` | The harness would not run or release it (L0, a non-human decider, a frozen scope, the pre-execution policy) |
| `agent.external_action.executed` | The handler returned |
| `agent.external_action.failed` | The handler threw or timed out |
| `agent.tool_secret.set` / `agent.tool_secret.deleted` | A secret was stored or removed (name only) |

The payload holds the tool name, its declaration (`capability`, `risk`,
`reversibility`, `blastRadius`, `secretRefs`), the agent, the run, tool call and
approval ids, the autonomy level, the decider kind, a `sha256` digest of the
arguments (`inputHash`) and the hash of the constitution pinned to the run. For a
tool with a policy it also holds `policy`: the outcome, the refusal code, the
hash of the version evaluated and each evaluator's id, status and `blocking`
flag. It never holds argument values, evaluator messages or handler output. The run, tool call and approval
records are written as for any tool call.

## MCP

`tools/call` reaches an external-action tool through the same
`AISecureHarness.execute` as the Agent API, so the decision is the same. The
parity property test covers this tool kind, and an integration test compares
both paths against the real harness for every combination of risk,
reversibility, autonomy level and capability.

`tools/list` advertises an external-action tool only to a caller that holds its
capability. `GET /api/v1/agent/tools` lists every registered tool with its
declaration under `external`.

An OAuth connector token is narrowed by its scopes as for built-in tools. An
administrator's token that lacks any of the MCP scopes is narrowed to the
built-in capability set, so it cannot call an external-action tool.

## Reference tool

`createHttpEchoTool` (`apps/cms/src/services/external-action-reference-tool.ts`)
posts a message to an endpoint and returns the response. It takes its endpoint
and its `fetch` as arguments and is not registered anywhere; the test suite hands
it an in-memory `fetch`. Use it as the template for a real tool.

## Multi-tenancy

| Resource | Scope |
|---|---|
| Tool definitions (code) | Shared by the deployment: a handler is code, not tenant data |
| Tool secrets (`lumibase_agent_tool_secrets`) | Per site. Unique on `(site_id, name)`, listed in `rls-policies.sql`, ciphertext bound to site and name |
| Autonomy grants, `agent_tools` overrides, approvals, runs, tool calls, audit rows | Per site, as for every tool call |

Verified by `external-action-tools.db.integration.test.ts`: a grant on one site
does not apply on another, a secret set on one site is missing on another, a
ciphertext copied to another site's row does not decrypt, an approval parked on
one site cannot be approved or rejected from another, and no run, tool call or
audit row appears on the site that did not act.

## Limits

- Money or volume caps are not part of this mechanism. A tool declares its blast
  radius; nothing here counts spend or recipients across calls.
- The pre-execution policy is opt-in per tool. A tool registered without one is
  governed by its declaration alone, even on a site with an active constitution.
- An `llm_judge` evaluator needs a configured LLM on the harness. Without one it
  errors, and a blocking judge then refuses every call (fail closed).
- The freeze boundary is the tool call: a handler already running is not
  interrupted. Write tools so one call does one bounded thing.
- Tools are registered in code at process start, directly or through the
  `externalActions` seam. There is no API to add one at runtime.

## Upgrading

Migration `0030_agent_tool_secrets` adds one site-scoped table. No backfill.
Existing installs need no action; nothing changes until a tool is registered.
`executeApproved` takes a fourth argument naming the decider. Callers that omit
it keep working for built-in skills and are refused for human-only approvals.

The pre-execution policy and the `externalActions` seam need no migration and
change nothing for a tool that declares no policy or for a deployment that
registers no seam. Constitution evaluators accept an optional `onViolation`
field; existing versions keep their hash.
