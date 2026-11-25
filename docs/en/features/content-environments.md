---
sourceLang: en
version: 1
lastUpdated: 2026-11-25T04:00:48.877Z
contentHash: a70da44e07706725
codeVerified: 2026-11-25T04:00:48.877Z
codeVerifiedHash: a70da44e07706725
codeVerifiedClaims: 14
---

# Content Environments

A content environment is an isolated copy of a site — its schema and, if you
choose, its content — where you can make a large change (rename fields, change
types, rewrite a hundred items for a new structure) without touching
production. When the work is done, you promote the schema and then the content
back to the original site, the **origin**.

Environments are tracked in [#853](https://github.com/khuepm/LumiBase/issues/853).
They ship dark behind the `content-environments` [release flag](./release-flags.md):
until the flag is released on the deployment and switched on for the site,
every route answers `404`.

## How it works

An environment is a **child site** of the origin, in the same organization.
Everything that is already isolated per site — queries, row-level security,
cache keys, search indexes — isolates the environment without any change. Three
tables hold what a site row cannot (`packages/database/src/schema/environments.ts`,
migration `0045_content_environments`):

| Table | Belongs to | Holds |
|---|---|---|
| `lumibase_environments` | origin | key, name, status, content scope, fork progress |
| `lumibase_environment_lineage` | environment | the identity map from each copied row to its origin row, with the **base**: the origin's state at fork time or at the last promote |
| `lumibase_environment_merge_runs` | origin | every applied promote with per-item outcomes |

Items keep their id across the fork (the same id in two sites). Collections,
fields, relations, files and folders get new ids and are mapped through
lineage.

## Fork

`POST /api/v1/environments` with `{ key, name, contentScope }` creates the
child site and answers `202` with `status: "forking"`. `contentScope` is
`{ mode: "none" }` (schema only), `{ mode: "all" }` or
`{ mode: "collections", collections: [...] }`.

The fork runs in steps under a short lease, like background imports: the
request runs the first steps, and the minute tick resumes the rest on Docker
and on Workers. Each step is idempotent, so a fork that stopped half-way
continues without duplicating rows. A fork that fails is `failed` with a reason;
`POST /api/v1/environments/:key/retry` resumes it from where it stopped.

What a fork copies:

- every collection, field and relation;
- roles, policies and permissions — but only the person who forked becomes a
  member of the environment;
- settings, except secrets and outbound targets (`revalidation.*`, mail,
  release flags, encryption and similar keys);
- webhooks and flows, **inactive**, webhooks without their secret or headers;
- folders and file metadata: the copy points at the same storage object, so no
  bytes are duplicated;
- items of the collections in scope, with the same id. Encrypted fields are
  decrypted with the origin's key context and encrypted again for the
  environment. References to files are mapped to the environment's file rows;
  a many-to-one reference into a collection outside the scope is kept and
  marked external.

What a fork never copies: API keys, sessions, audit log, revisions, agent
memory and trust ledger, releases, content versions, materialized collections,
Firebase Sync pipelines, Change Feed subscriptions, deployments, intents and
extensions. No extension is enabled in a new environment.

Limits: `environments.maxPerSite` (default 3) environments per origin, and
`environments.maxItemsPerFork` (default 50 000) items in the content scope.
Over a limit, the fork is refused with `409 ENVIRONMENT_LIMIT_REACHED` or
`409 ENVIRONMENT_TOO_LARGE`. An environment cannot itself be forked
(`409 ENVIRONMENT_NESTING_UNSUPPORTED`).

## Working in an environment

In Studio, **Settings → Environments → Open in Studio** switches the active
site to the environment. A banner stays on every screen while you are inside
one, with a way back to the origin.

Nothing in an environment reaches the outside world:

- webhooks and flows are copied inactive, and the flow dispatcher, the
  Change Feed webhook sender, Firebase Sync, ISR revalidation and agent push
  notifications also refuse to send for an environment, even if someone turns
  them back on;
- push notifications stay off until an admin of the environment sets
  `environments.sideEffects.notifications` to `true`;
- public delivery of an environment answers `X-Robots-Tag: noindex, nofollow`.

The child site carries a platform setting, `environment.origin`, that these
checks read. The settings API refuses to write or delete any `environment.*`
key (`403 SETTING_RESERVED`).

## Promote the schema

`POST /api/v1/environments/:key/promote/schema` with `{ dryRun: true }` returns
the plan; with `dryRun: false` it applies it.

Rows are matched by lineage, not by name. For each collection, field and
relation, the plan compares three states — the base, the environment now and
the origin now:

| Origin vs base | Environment vs base | Action |
|---|---|---|
| same | same | `unchanged` |
| same | changed | `create`, `update` or `rename` |
| changed | same | `origin-only` (nothing to do) |
| changed | changed | `conflict` |

A field renamed in the environment is promoted as a **rename**, and the
origin's values move to the new name. Some changes are refused with a reason
(`blocked`): renaming a collection, renaming an encrypted field, switching a
field's encryption on or off, and changing which field a relation lives on.

An apply is refused with `422` until:

- every conflict has a resolution: `resolutions: [{ kind, key, take: "origin" | "environment" }]`
  (`UNRESOLVED_CONFLICTS`);
- risky changes — rename, type change, delete — carry `confirmRiskyChange: true`
  (`RISKY_CHANGE_UNCONFIRMED`);
- a type change carries a plan with a strategy, for example
  `migrationPlans: { "posts.rating": { "strategy": "cast-integer" } }`
  (`MIGRATION_PLAN_REQUIRED`).

The apply runs in one transaction on the origin. **It cannot be undone.** A
type change updates the field definition; like any schema change in LumiBase,
it does not convert the values already stored.

## Promote content

`POST /api/v1/environments/:key/promote/content` with `{ dryRun, items? }`
promotes items changed in the environment; `items: [{ collection, itemId }]`
limits the run to those items.

Each item is compared in the origin's terms (file ids mapped back, encrypted
values compared by hash):

| Result | When |
|---|---|
| `promote` | only the environment changed the item |
| `create` | the item was created in the environment; it is created in the origin with the **same id** |
| `delete` | the item was deleted in the environment and the origin did not change it |
| `conflict` | the origin changed the item too — **it is never overwritten** |
| `blocked` | `SCHEMA_NOT_PROMOTED` (promote the schema first) or `DEPENDENCY_NOT_PROMOTED` (it references an item that is neither in the origin nor in this run) |

Writes go through your own permissions on the origin, with its validation,
editorial workflow and pinned fields, exactly as a normal edit. Each update
sends the origin version the plan was made from, so an edit that lands in the
origin between the plan and the write turns the item into a `conflict` instead
of being lost. New items are created in dependency order; two new items that
reference each other are created first and linked after. Files that exist only
in the environment are registered in the origin, on the same storage object.

What is promoted is the item's `data`. Its status, publish window and order stay
as they are in the origin; an item created by the promote takes the
environment's status through the editorial workflow.

The result lists every item with an outcome (`promoted`, `created`, `deleted`,
`conflict`, `skipped`, `failed`, `unchanged`). Revisions written in the origin
name the source: `sources: [{ type: "environment", environmentId, mergeRunId }]`.
A run that stops half-way can be repeated: applied items now match their new
base and are not written twice. One run looks at up to 2 000 items
(`truncated: true` beyond that; run again).

To bring an item the origin also changed, edit it in the origin directly, or
fork a fresh environment. Three-way merge and undo of a content promote are
planned for a later version.

## Concurrency and audit

A promote moves the environment to `merging`; while one promote runs, any
other promote on the same origin answers `409 ENVIRONMENT_BUSY`, and so does
deleting that environment. A lock left by a crashed promote is taken over after
15 minutes.

Audit events: `environment_forked`, `environment_deleted`,
`environment_schema_promoted`, `environment_content_promoted`. Metadata carries
ids and counts, never item content.

## Who can do what

Every route needs a signed-in staff user who is an administrator of the origin
site. API keys are refused, even with `schema:write` (`403 STAFF_USER_REQUIRED`).
An environment is always looked up under the request's own site; another
site's key answers `404`. No agent skill can fork or promote in this version.

## Delete

`DELETE /api/v1/environments/:key` deletes the child site and everything in it.
The origin is not touched, and storage objects shared with the origin are not
deleted.

## Limits of this version

- One level: an environment cannot be forked.
- Content promote is one-way; three-way merge, rebase from the origin and
  undo come later.
- File ids are mapped in fields whose interface is `file` or `files`. File ids
  inside rich text or free-form JSON keep their origin value.
- Objects that exist only in the site-prefixed media library (`/media`) are not
  shared with an environment.

## Studio

**Settings → Environments** (shown once the flag is on): fork, watch progress,
open, retry, delete, and preview the schema and content plans before applying
them.

## API summary

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/environments` | List |
| `POST` | `/api/v1/environments` | Fork (`202`) |
| `GET` | `/api/v1/environments/:key` | Detail with `originChanged`, `changedItems`, `truncated` |
| `DELETE` | `/api/v1/environments/:key` | Delete |
| `POST` | `/api/v1/environments/:key/retry` | Resume a failed fork |
| `POST` | `/api/v1/environments/:key/promote/schema` | Schema plan / apply |
| `POST` | `/api/v1/environments/:key/promote/content` | Content plan / apply |
| `GET` | `/api/v1/environments/:key/merge-runs` | Applied promotes |

Full request and error reference: [API spec](../api/hono-api-spec.md#3d-content-environments-853).
