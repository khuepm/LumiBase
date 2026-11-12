---
version: 2
lastUpdated: 2026-11-12T18:43:32.411Z
sourceLang: en
contentHash: ef3117c0b3b07b7c
codeVerified: 2026-11-12T18:43:32.411Z
codeVerifiedHash: ef3117c0b3b07b7c
codeVerifiedClaims: 24
---

# Site Skills

A **site skill** is a playbook your team writes down for the agents: house
style, translation rules, how a product page is structured, what a headline
must never say. It is Markdown with a small front matter block, stored per
site, versioned, and added to the instructions of every agent run it applies
to.

> **Naming.** "Skill" also names the callable tools of the harness
> (`listItems`, `aiContentAssist`, … — see [AI skills](../ai-skills.md)). Those
> are code and live in `lumibase_agent_tools`. A *site* skill is prose and
> lives in `lumibase_site_skills`. A site skill never adds a tool.

## What a site skill can and cannot do

| It does | It does not |
|---|---|
| Add instruction text to matching runs | Grant a capability or a tool |
| Shape tone, structure and process | Change the output format a tool requires |
| Leave a `slug@version` + hash stamp on what it shaped | Bypass HITL, autonomy levels, the kill switch or the constitution publish gate |

Governance is decided exactly as it is without skills. The worst a badly
written skill can do is make the model write badly — which is why authoring is
still a governed act (see [Governance](#governance)).

## Document format

```markdown
---
slug: house-style
name: House style
description: Voice and formatting rules for editorial copy
riskClass: low
priority: 10
surfaces: [copilot, generation]
tools: [aiContentAssist]
collections: [posts]
triggers: [headline, intro]
requiredCapabilities: [items:write]
---

# House style

Write in active voice. Sentences under 25 words.
Never use "utilize"; say "use".
```

| Key | Meaning | Default |
|---|---|---|
| `slug` | Identity, unique per site. Lowercase letters, digits, single hyphens; at most 64 characters. Cannot be changed. `import`, `export` and `match` are reserved. | file name |
| `name` | Display name, at most 120 characters. | first `# heading` |
| `description` | One line, at most 500 characters. Shown in lists and as the MCP prompt description. | empty |
| `riskClass` | `low`, `medium` or `high`. A label for review priority, shown in Studio. It does not change who may edit or activate the skill. | `low` |
| `priority` | `-100` to `100`. Higher is injected first when the budget is tight. | `0` |
| `surfaces` | `copilot`, `generation`, `mcp`. Empty means all. | all |
| `tools` | Harness tool names the skill is limited to. Empty means any. | any |
| `collections` | Collection names the skill is limited to. Empty means any. | any |
| `triggers` | Keywords matched case-insensitively against the request text. Empty means "always, within scope". | always |
| `requiredCapabilities` | Capabilities the caller must hold for the skill to be offered. | none |

The front matter is a deliberately small YAML subset: `key: value`,
`key: [a, b]`, and `key:` followed by `- item` lines. Unknown keys are an
error, not ignored — a typo in `triggers` must not silently turn a narrow skill
into one that applies everywhere. The body is 1 to 12,000 characters — the
same as the per-run [budget](#budget), so any single skill can always be
injected. Leading blank lines and trailing whitespace are dropped on every
path (Studio, JSON API, import), so a body that differs only there is the same
content and hashes the same.

## Where skills are injected

Only `active` skills are injected. A site with no active skill sends exactly
the requests it sent before this feature existed.

| Surface | Where | Matching context |
|---|---|---|
| `copilot` | `POST /api/v1/ai/chat`, synchronous and `Prefer: respond-async` | the newest 3 user turns of the conversation window sent to the model, plus the current message; the caller's capabilities |
| `generation` | harness tools that call a model: `aiContentAssist`, `aiSuggestField`, `repairTranslation`, `generateAppSpec`, `generateSeedData` | the tool name, its collection, its instruction |
| `mcp` | `prompts/list` and `prompts/get` on `POST /api/v1/mcp` | the caller's capabilities (the client picks, so triggers do not filter) |

Matching rules:

- **Scope is conjunctive.** Surface, tool, collection, capabilities and
  triggers must all pass.
- **Collection.** When the run names a collection it must be listed. When it
  does not (a chat message), the skill applies only if the text mentions a
  listed collection. Unknown never means "apply".
- **Capabilities fail closed.** Inside a generation tool the caller's
  capabilities are not known, so a skill with `requiredCapabilities` is
  withheld there. It still applies in the Copilot and over MCP.
- **Grounded generation is exempt.** `aiContentAssist` with `grounded: true`
  extracts exact quotes from evidence; no playbook is added to that call.

### Budget

At most 6 skills and 12,000 body characters are injected into one run, ordered
by `priority` (descending) then `slug`. A skill that does not fit is skipped
whole — a truncated playbook is worse than a missing one — and smaller skills
behind it may still fit. `POST /api/v1/agent/skills/match` shows what a given
run would receive, including what was skipped.

### Provenance

Every injection is recorded as `{ slug, version, hash }`:

- generation tools return it as `meta.siteSkills`, which the agent run trail
  persists with the tool call;
- the Copilot stores it in the assistant message metadata and returns it as
  `siteSkills` in the chat response;
- `prompts/get` returns it under `_meta["lumibase/siteSkill"]`.

Editing a skill later does not rewrite history: the version row a run was
stamped with is immutable.

## Versions

Every content change appends a row to `lumibase_site_skill_versions` with the
full snapshot, its sha256 hash, the author (user id, or `api_key:<id>`), the
source (`studio`, `api`, `cli`, `package`), an optional source reference and
change note. A write that does not change the content (same hash) creates no
version. Restoring version *N* writes its content as a **new** version, so the
trail only grows.

The author is recorded by the server from the authenticated principal and is
the authoritative "who". `source` and `sourceRef` are labels the client
declares (the CLI sends `cli` or `package`, Studio sends `studio`); they are
useful context, not proof of origin.

Each write — the skill row, its version row and its activity entry — is one
database transaction: if any statement fails, none of them is kept, and the
next write continues from the last committed version.

Status (`draft` → `active` → `archived`) is not part of the version: it says
whether the current version is live. Activation, archival, edits and deletion
are written to the activity log as `site_skill.*` entries, each with the
skill's id (`skillId`) and slug.

A skill that has ever been activated cannot be deleted (`409
SKILL_HAS_BEEN_ACTIVE`): runs may be stamped with its versions, and deleting
the skill would delete that trail. Archive it instead. A draft that was never
active can be deleted, together with its versions.

> Editing an `active` skill changes agent behaviour immediately. To stage a
> change, return the skill to `draft` first, or push it from a branch and
> activate on merge.

### Concurrent edits

`PATCH` takes an optional `expectedVersion` and the status actions
(`activate`, `archive`, `draft`) take an optional `version`. When given and the
skill has moved on, the write is refused with `409 VERSION_MISMATCH` and the
error carries `currentVersion`. Studio sends both: the version the editor
loaded, and the version on screen when you click **Activate** — so you never
activate content you did not see.

## Governance

- The whole surface lives under `/api/v1/agent`, which the control-plane guard
  limits to admin principals. Reading a skill needs the same: the MCP
  `prompts/*` methods apply that rule themselves (see [MCP](#mcp)).
- **Every write needs a control-plane admin** — create, edit, restore, import,
  activate, archive and delete. The route checks it again after the guard, so
  it holds on any mount.
- Delegated (non-admin) skill authors are not supported yet: there is no
  capability that lets a non-admin write skills. `riskClass` does not change
  who may write either; it is a label that helps reviewers decide what to
  look at first. Use `high` for playbooks that steer consequential behaviour
  (pricing copy, legal wording, anything an autopilot-level agent will act on
  unreviewed).
- New skills are always created as `draft`. Imported skills stay `draft`
  unless the import says `activate`. An import never changes the content of an
  `active` skill unless it says `updateActive` (see [Skills as code](#skills-as-code)).
- Skills are trusted instructions because of who may write them. Content,
  retrieved documents and chat messages can never become a skill, and they
  keep entering prompts as untrusted data.

## API

All routes are under `/api/v1/agent/skills`. `:id` accepts the id or the slug.

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | List skills. Optional `?status=draft\|active\|archived`. |
| `POST` | `/` | Create a draft. Body: the front matter fields plus `body`; optional `source`, `sourceRef`, `changeNote`. `201`; `409 CONFLICT` on a duplicate slug. |
| `GET` | `/:id` | One skill, plus `document` (the Markdown form). |
| `PATCH` | `/:id` | Partial update; omitted fields are kept. Optional `expectedVersion` (`409 VERSION_MISMATCH` when the skill moved on). `meta.changed` is `false` when nothing changed. `slug` cannot change. |
| `DELETE` | `/:id` | Delete a skill that was never active, with its version trail. Audited. `409 SKILL_HAS_BEEN_ACTIVE` for a skill that has ever been activated — archive it instead. |
| `POST` | `/:id/activate` · `/:id/archive` · `/:id/draft` | Change status. Optional body `{ version }` (`409 VERSION_MISMATCH` when the skill moved on). |
| `GET` | `/:id/versions` | Version trail, newest first. |
| `POST` | `/:id/versions/:version/restore` | Write an old version's content as a new version. |
| `POST` | `/import` | Upsert Markdown documents by slug. Body `{ documents: [{ path?, content }], activate?, dryRun?, updateActive?, source?, sourceRef? }`, 1–100 documents. Returns one result per document (`created`, `updated`, `unchanged`, `error`) and counts in `meta`. One bad document does not abort the rest. A content change to an `active` skill is that document's error (`ACTIVE_SKILL_CHANGE`) unless `updateActive` is `true`. |
| `GET` | `/export` | Every skill as `{ slug, filename, status, version, hash, content }`. Re-importing an export is a no-op. |
| `POST` | `/match` | Preview. Body `{ surface, tool?, collection?, text? }`; returns `{ skills, skipped, prompt }` evaluated with the caller's capabilities. |

Errors use the standard envelope: `VALIDATION` (400), `INVALID_DOCUMENT` and
`ACTIVE_SKILL_CHANGE` (per document, in import results), `FORBIDDEN` (403, not
a control-plane admin), `NOT_FOUND` (404), `CONFLICT`, `VERSION_MISMATCH` and
`SKILL_HAS_BEEN_ACTIVE` (409).

## Skills as code

Keep playbooks in git next to your content model and let CI deploy them:

```bash
lumibase skills pull                 # write skills/<slug>.skill.md from the site
lumibase skills push --dry-run       # show what would change
lumibase skills push --check         # CI gate: exit 1 if the site differs from git
lumibase skills push --activate      # deploy and activate
lumibase skills install @acme/lumibase-skills   # import a package's skills as drafts
```

`push` and `install` are idempotent: a document whose hash matches the stored
version is reported `unchanged` and writes nothing.

`push` is the deploy path — the directory is the source of truth — so it sends
`updateActive: true` and its changes to `active` skills go live at once.

`install` reads skills from a locally installed package (`package.json` →
`lumibase.skills`, default `skills/`) or from a path; it downloads nothing.
New skills arrive as drafts for a human to review in Studio (unless
`--activate`), and `install` never changes a skill that is already active: such
a document is reported as `ACTIVE_SKILL_CHANGE` and the live skill is left as
it was.

The token needs control-plane admin access to the site and is read from
`LUMIBASE_TOKEN`, never from the config file. See [CLI](../cli/index.md).

## Studio

**Mission Control → Skills** lists skills with their status, risk class and
scope; edits the front matter and the Markdown body; activates, archives and
deletes; shows the version trail with restore; and has a **Test match** panel
that calls `/match` so you can see which skills a sample request would receive.
Saving and activating send the version you are looking at, so someone else's
newer edit is reported instead of overwritten. **Delete** is offered only for
skills that were never active; for the others, archive.

## MCP

With the `contentOs.mcp` flag on, the MCP endpoint advertises the `prompts`
capability. `prompts/list` returns the active skills offered to the caller
(`name` is the slug); `prompts/get` returns the body as a single user message.

Prompts are served only to callers that could read skills over REST: a
principal that resolves to a control-plane admin for the site. For anyone else
— a non-admin member, a site API key — `prompts/list` is empty. On top of that,
each skill's `surfaces` and `requiredCapabilities` still filter what an admin
sees. A prompt the caller may not see and a prompt that does not exist answer
identically. Organization-plane calls (`org:*`) do not offer prompts.

## Multi-tenancy

| Resource | Scope |
|---|---|
| `lumibase_site_skills`, `lumibase_site_skill_versions` | Isolated per site: `site_id` on both, every query filtered by it, and both in the `site_isolation` RLS list of `packages/database/migrations/rls-policies.sql`. |
| Slug | Unique per site; two sites may use the same slug independently. |
| Injection | Resolved per run from the run's own site id — the request's site for the Copilot and MCP, the job's `siteId` for queued work. |
| Prompt budget, preamble text | Shared constants in code; no tenant data. |

Verified by `apps/cms/src/services/__tests__/site-skills.db.integration.test.ts`
("tenant isolation"): site B cannot list, read, match, edit, export or delete
site A's skills, and a generation run on site B receives none of them.

## Upgrading

Migration `0026_site_skills` creates the two tables and alters nothing
existing; no backfill is needed. Re-apply `rls-policies.sql` afterwards, as
after every upgrade. If the code is deployed before the migration runs, agent
runs continue without playbooks and log a warning; they do not fail.
