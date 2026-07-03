# Hono API Specification — LumiBase

> **For AI agents:** This page is also available as clean Markdown. Append `/index.md` to any LumiBase docs URL.
>
> **Base URL:** `https://api.<your-site>.lumibase.dev` (or `http://localhost:1989` in local dev)
>
> All endpoints are versioned under `/api/v1`. Every request must include:
> - `Authorization: Bearer <token>` — login `token`, or an API key (`lbk_…`)
> - `X-Lumi-Site: <siteId>` — site identifier (or resolved via subdomain routing)

---

## Response envelope

All responses follow this structure:

```json
{
  "data": <T>,
  "meta": {
    "total": 123,
    "page": 1,
    "pageSize": 50,
    "filter_count": 50
  }
}
```

Error response:

```json
{
  "errors": [
    {
      "code": "PERMISSION_DENIED",
      "message": "You don't have permission to read field 'secret'.",
      "path": ["fields", "secret"],
      "extensions": { "reason": "field_policy" }
    }
  ]
}
```

### Error codes

| Code | HTTP | Description |
|------|------|-------------|
| `PERMISSION_DENIED` | 403 | Policy check failed |
| `RECORD_NOT_FOUND` | 404 | Item does not exist or not visible to this role |
| `VALIDATION_FAILED` | 400 | Input schema validation error |
| `CONFLICT` | 409 | Unique constraint violated |
| `RATE_LIMITED` | 429 | Rate limit exceeded |
| `SITE_NOT_FOUND` | 404 | `X-Lumi-Site` header resolves to unknown tenant |
| `TOKEN_EXPIRED` | 401 | JWT has expired — refresh and retry |
| `SKILL_DENIED` | 403 | AI skill requires a capability the session lacks |
| `HITL_REQUIRED` | 202 | Dangerous operation gated for human approval |

---

## Standard query parameters (list endpoints)

| Parameter | Example | Description |
|-----------|---------|-------------|
| `fields` | `fields=id,title,author.name` | Select specific fields + nested relations |
| `filter` | `filter[status][_eq]=published` _or_ `filter={"status":{"_eq":"published"}}` | Filter using rule operators — see [Filter forms](#filter-forms) |
| `sort` | `sort=-updated_at,title` | Comma-separated, `-` prefix for DESC |
| `page` | `page=2` | Page number (1-indexed) |
| `limit` | `limit=25` | Items per page (max 200) |
| `aggregate[count]` | `aggregate[count]=*` | Aggregate functions |
| `groupBy` | `groupBy=status` | Group aggregation results |
| `deep` | `deep[author][fields]=name,avatar` | Nested relation query params |

> Full-text search is a **separate endpoint**, `GET /api/v1/search` (MeiliSearch),
> not a list-endpoint parameter. It supports single-collection and
> cross-collection (omit `collection`) queries and is diacritics-insensitive for
> Vietnamese. See [features/search.md](../features/search.md).

### Filter operators

| Operator | Description |
|----------|-------------|
| `_eq` | Equals |
| `_neq` | Not equals |
| `_lt`, `_lte`, `_gt`, `_gte` | Comparison |
| `_in`, `_nin` | In / not in array |
| `_null`, `_nnull` | Is null / not null |
| `_contains`, `_icontains` | Contains (case-sensitive / insensitive) |
| `_starts_with`, `_ends_with` | String prefix/suffix |
| `_between` | Range (two-element array) |
| `_and`, `_or` | Logical grouping |
| `_json_contains` | JSONB `@>` — value/sub-object/array-membership containment |
| `_has_key` | The JSON object has this key |
| `_has_any_keys`, `_has_all_keys` | The JSON object has any / all of these keys (string array) |

**Searching inside JSON.** A filter field key may be a **dotted path** into a
nested JSON/JSONB field — e.g. `filter={"metadata.author.country":{"_eq":"VN"}}`
compiles to a `data #>> '{metadata,author,country}'` lookup. Path segments are
restricted to `[A-Za-z0-9_]` and bound as parameters (injection-safe); depth is
capped at 8. The `_json_contains` / `_has_*` operators run against the JSONB and
use the existing GIN index. Top-level keys and structural fields behave exactly
as before.

### Filter forms

List endpoints accept the `filter` query parameter in **two equivalent forms** — use
whichever is more convenient. Both produce the same filter object server-side.

**1. Bracket form** — ergonomic for hand-written URLs and HTML forms:

```
GET /api/v1/items/articles?filter[status][_eq]=published&filter[views][_gte]=100
```

- Nesting maps directly: `filter[field][_op]=value`.
- Values are coerced: `true`/`false` → boolean, `null` → null, clean integers/decimals →
  number (leading-zero strings like `007` stay strings), everything else → string.
- Array operators (`_in`, `_nin`, `_between`) accept comma-separated values:
  `filter[status][_in]=published,scheduled`.
- Logical groups use an index segment: `filter[_and][0][status][_eq]=published`.

**2. JSON form** — better for complex/programmatic filters and the SDK:

```
GET /api/v1/items/articles?filter={"status":{"_eq":"published"}}
```

> If **both** are supplied on the same request, the **JSON form wins**. A malformed JSON
> `filter` returns `400 VALIDATION`; a malformed bracket key is ignored rather than
> failing the whole request.

---

## 1. Auth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/login` | Exchange username/password (or Logto auth code) for a bearer token |
| `POST` | `/api/v1/auth/refresh` | Refresh expired access token |
| `POST` | `/api/v1/auth/logout` | Revoke tokens |
| `GET` | `/api/v1/auth/me` | Get current user profile |
| `GET` | `/api/v1/me/preferences` | The current user's preferences blob (`users.preferences`) |
| `PATCH` | `/api/v1/me/preferences` | Shallow-merge a validated preferences patch |
| `GET` | `/api/v1/me/consents` | List the current user's consent decisions |
| `PUT` | `/api/v1/me/consents/:type` | Grant or withdraw a consent (GDPR Art. 7, PDPD) |
| `GET` | `/api/v1/me/data-export` | Download the current user's personal data (GDPR Art. 15/20) |
| `GET` | `/api/v1/me/restriction` | Current restriction-of-processing state (GDPR Art. 18) |
| `PUT` | `/api/v1/me/restriction` | Set restriction of processing (`{ restricted, reason? }`) |
| `GET` | `/api/v1/me/automated-decisions` | Agent-authored revisions on the user's content (GDPR Art. 22) |
| `GET` | `/api/v1/retention` | Admin: report configured retention horizons |
| `POST` | `/api/v1/retention/run` | Admin: prune `activity` + handled `notifications` past their horizons |

> Account erasure (GDPR Art. 17) and Subject Access Requests are served by the
> regulated-content-readiness feature at `/api/v1/admin/erasure` and
> `/api/v1/admin/sar`.

**Consent management** (`:type` ∈ `marketing` · `analytics` · `personalization` · `functional` · `sale_share`):

```jsonc
// PUT /api/v1/me/consents/marketing
{ "granted": true, "source": "preference_center", "version": "v1" }

// Response
{ "data": { "consentType": "marketing", "granted": true,
            "grantedAt": "2026-06-24T10:00:00.000Z", "withdrawnAt": null,
            "source": "preference_center", "version": "v1",
            "updatedAt": "2026-06-24T10:00:00.000Z" } }
```

Each change writes a `consent_granted` / `consent_withdrawn` audit event. Only user
principals (not API keys) can manage consent. Current state is stored per
`(site_id, user_id, consent_type)` in `user_consents`; full history lives in the audit log.

**Email unsubscribe & suppression** (CAN-SPAM):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/v1/email/unsubscribe?token=…` | public | One-click unsubscribe (renders HTML confirmation) |
| `POST` | `/api/v1/email/unsubscribe` | public | RFC 8058 one-click (token in query or form body) |
| `GET` | `/api/v1/email/suppressions` | admin | List suppressed addresses |
| `POST` | `/api/v1/email/suppressions` | admin | Add an address (`{ email, reason? }`) |
| `DELETE` | `/api/v1/email/suppressions/:email` | admin | Remove an address (re-subscribe) |

The unsubscribe token is a stateless HS256 JWT (`{ siteId, email }`, no expiry) signed
with `JWT_SECRET`. Marketing sends (`EmailModuleService.send({ category: 'marketing' })`)
filter recipients against `email_suppressions` before dispatch. Unsubscribe/suppression
changes audit `email_unsubscribed` / `email_suppressed` / `email_unsuppressed`.

**Preferences & save action.** `PATCH /api/v1/me/preferences` shallow-merges a
validated patch into `users.preferences` (other sections like `language` /
`keybindings` are preserved). Send `{ "saveAction": "stay" | "return" |
"create_new" }` to set the Studio editor's post-save navigation; send
`{ "saveAction": null }` to fall back to the site default
(`sites.default_save_action`, set via `PATCH /api/v1/site`). Invalid enum → 400.

### External JWT authentication

A site can trust JWTs issued by an external IdP (Okta, Entra, Auth0, Logto,
Keycloak, Cloudflare Access…). Present the token as `Authorization: Bearer
<jwt>` with `X-Lumi-Site`. The auth chain verifies it against the issuer's
**public JWKS** (between the API-key and internal-JWT branches): it matches the
token's `iss` to a trusted issuer registered for that site, verifies the
signature + `aud`/`exp`/`nbf` with the issuer's allowed (asymmetric-only)
algorithms, maps role claims to LumiBase roles (**default-deny** — no mapping
means 403, never implicit admin), enforces that any `siteId` claim equals the
request site, and optionally JIT-provisions the user. A token whose `iss` isn't
trusted is ignored (falls through to internal auth); once an issuer matches,
verification is fail-closed.

Admin CRUD for trusted issuers (admin-only):

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/admin/auth/issuers` | List trusted external issuers |
| `POST` | `/api/v1/admin/auth/issuers` | Register an issuer |
| `GET` | `/api/v1/admin/auth/issuers/:id` | Get one |
| `PATCH` | `/api/v1/admin/auth/issuers/:id` | Update |
| `DELETE` | `/api/v1/admin/auth/issuers/:id` | Remove |

**Issuer config:** `{ issuer, jwksUri | discoveryUrl, audience, algorithms
(RS*/ES* only), claimMapping: { email, roles, siteId?, externalId? }, roleMapping:
{ "<claim role>": { roleId | systemKey } }, defaultRoleId?, jitProvisioning,
clockSkewSeconds (≤300), enabled }`. Errors: `VALIDATION_FAILED` (422, incl. an
HS*/`none` algorithm), `ISSUER_ALREADY_EXISTS` (409), `NOT_FOUND` (404).

**Login request:**
```json
{
  "email": "admin@example.com",
  "password": "your-password"
}
```

**Login response:** a single bearer `token` plus the user profile. Send the token as
`Authorization: Bearer <token>` on subsequent requests.

```json
{
  "data": {
    "token": "eyJ...",
    "user": {
      "id": "usr_abc123",
      "email": "admin@example.com",
      "firstName": "Admin",
      "lastName": "User",
      "avatar": null
    }
  }
}
```

> For long-lived server-to-server access, create an API key
> (`POST /api/v1/api-keys`, token prefix `lbk_`) instead of using a login token.

---

## 2. Schema Admin

### Collections

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/collections` | List all collections |
| `POST` | `/api/v1/collections` | Create a new collection |
| `GET` | `/api/v1/collections/:name` | Get collection detail |
| `PATCH` | `/api/v1/collections/:name` | Update collection meta (display name, icon, note) |
| `DELETE` | `/api/v1/collections/:name` | Soft-delete collection |
| `GET` | `/api/v1/collections/:name/schema` | Export collection schema as JSON |
| `PUT` | `/api/v1/collections/:name/schema` | Apply schema (idempotent, diff-aware) |
| `POST` | `/api/v1/collections/diff` | Compare bundle schema vs current |

**Create collection request:**
```json
{
  "name": "articles",
  "displayName": "Articles",
  "icon": "article",
  "note": "Blog articles",
  "singleton": false,
  "status_field": "status",
  "sort_field": "sort"
}
```

### Fields

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/fields/:collection` | List fields in a collection |
| `POST` | `/api/v1/fields/:collection` | Add a field |
| `GET` | `/api/v1/fields/:collection/:field` | Get field detail |
| `PATCH` | `/api/v1/fields/:collection/:field` | Update field config |
| `DELETE` | `/api/v1/fields/:collection/:field` | Remove field |

**Create field request:**
```json
{
  "field": "title",
  "type": "string",
  "interface": "input",
  "display": "raw",
  "options": { "placeholder": "Article title" },
  "required": true,
  "sort": 1
}
```

### Relations

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/relations` | List all relations |
| `POST` | `/api/v1/relations` | Create relation |
| `PATCH` | `/api/v1/relations/:id` | Update relation |
| `DELETE` | `/api/v1/relations/:id` | Remove relation |

### Code-First Configuration (Config Manifest)

Export / diff / apply a site's **schema configuration** — collections, fields,
relations, settings and webhooks — as a single declarative, version-controllable
JSON manifest (`lumibase.config@v1`). Built for CI/CD and environment sync (à la
Directus schema snapshot/apply). **Admin-only.** Does **not** include content
items, secrets, or access control (use `/api/v1/access/*` for the latter).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/config/export?scope=all\|schema\|settings\|webhooks` | Export the config manifest |
| `POST` | `/api/v1/config/import?dryRun=true&mode=<mode>` | Validate + diff a manifest (no write) |
| `POST` | `/api/v1/config/import?mode=<mode>&allowDestructive=true` | Apply a manifest in one transaction |

`mode` ∈ `merge` (create/update only — never deletes), `replace-managed` (also
deletes resources within the manifest's `managedScopes`), `replace-all` (full
sync — deletes anything absent from the manifest). High-risk destructive changes
(dropping a collection/field with data, changing a field type, widening a
relation's `onDelete` to `cascade`) are rejected unless `allowDestructive=true`.

**Export response** (`{ data: ConfigManifest }`):
```json
{
  "data": {
    "version": "lumibase.config@v1",
    "exportedAt": "2026-06-22T00:00:00.000Z",
    "collections": [{ "name": "articles", "label": "Articles", "versioning": true }],
    "fields": [{ "collection": "articles", "field": "title", "type": "string", "interface": "input" }],
    "relations": [],
    "webhooks": [],
    "settings": [{ "key": "login_security_policy", "value": { } }],
    "managedScopes": ["articles"]
  }
}
```

**Dry-run / apply response** (`{ data: { valid, errors, diff, applied? } }`): the
`diff` lists per-resource `create | update | unchanged | delete` counts and a
top-level `risk` (`low | medium | high`). On apply, `applied` reports
`{ created, updated, deleted }`. Validation errors use codes
`UNSUPPORTED_MANIFEST_VERSION`, `DANGLING_REFERENCE`, `DUPLICATE_KEY`; a blocked
destructive apply returns HTTP 409 `DESTRUCTIVE_BLOCKED`.

CLI: `pnpm --filter @lumibase/cms config export|diff|apply` — see
[`docs/en/contributing/code-first-config.md`](../contributing/code-first-config.md).

---

## 3. Items (Generic CRUD)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/items/:collection` | List items (paginated, filterable) |
| `POST` | `/api/v1/items/:collection` | Create item (or array for bulk) |
| `GET` | `/api/v1/items/:collection/:id` | Get single item |
| `PATCH` | `/api/v1/items/:collection/:id` | Partial update |
| `PUT` | `/api/v1/items/:collection/:id` | Full replace |
| `DELETE` | `/api/v1/items/:collection/:id` | Delete item (or array bulk) |
| `GET` | `/api/v1/items/:collection/:id/revisions` | List revisions |
| `POST` | `/api/v1/items/:collection/:id/revert` | Revert to revision |
| `GET` | `/api/v1/items/:collection/:id/versions` | List named draft versions (each has a `mainChanged` flag) |
| `POST` | `/api/v1/items/:collection/:id/versions` | Create a version `{ key, name }` (snapshots current main) |
| `GET` | `/api/v1/items/:collection/:id/versions/:key` | Get a version |
| `PATCH` | `/api/v1/items/:collection/:id/versions/:key` | Update a version `{ data?, name? }` (does not touch main) |
| `DELETE` | `/api/v1/items/:collection/:id/versions/:key` | Delete a version |
| `GET` | `/api/v1/items/:collection/:id/versions/:key/compare` | Field diff vs main → `{ main, version, changes }` |
| `POST` | `/api/v1/items/:collection/:id/versions/:key/promote` | Apply version to main (writes a revision); `meta.mainDiverged` |

**Optional headers:**
- `X-Lumi-Draft: true` — fetch draft version
- `X-Lumi-Locale: vi` — apply translation server-side

**Create item:**
```json
{ "title": "Hello World", "status": "draft", "author": "usr_abc123" }
```

**Bulk create (array body):**
```json
[
  { "title": "Article 1", "status": "published" },
  { "title": "Article 2", "status": "draft" }
]
```

---

## 3b. Content Releases

A **Release** collates specific item revisions across collections into a named
bundle that publishes all at once — manually or scheduled for a date/time
(à la Directus Releases). Publish delegates to the item update path, so the
editorial gate, validation, permissions and hooks all apply.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/releases` | Create a release (`draft`, or `scheduled` if `publishAt` set) |
| `GET` | `/api/v1/releases` | List releases (`?status=&page=&limit=`) |
| `GET` | `/api/v1/releases/:id` | Release detail + its items |
| `PATCH` | `/api/v1/releases/:id` | Update meta, `addItems`/`removeItems`, set `publishAt` |
| `POST` | `/api/v1/releases/:id/publish` | Publish now (manual) |
| `DELETE` | `/api/v1/releases/:id` | Delete release (items cascade) |

**Create / patch body:**
```json
{
  "name": "Spring launch",
  "atomicityMode": "all_or_nothing",
  "publishAt": "2026-07-01T09:00:00Z",
  "maintenanceWindow": { "windows": [{ "dow": 1, "start": "09:00", "end": "17:00" }] },
  "addItems": [
    { "collection": "articles", "itemId": "itm_1", "targetStatus": "published", "revisionId": "rev_3" }
  ]
}
```

`atomicityMode`: `all_or_nothing` (pre-flight checks every item is publishable —
exists, not deleted, editorial gate satisfiable — and publishes nothing if any
is blocked) or `best_effort` (publishes each independently, recording a per-item
outcome). `revisionId` pins a specific revision's snapshot; omit it to publish
the item's live state at publish time.

**Publish response** (`{ data: { release, status, outcomes } }`): `status` is
`published` | `partially_failed` | `failed`; each outcome is
`{ collection, itemId, outcome: 'published'|'skipped'|'failed', reason? }`. A
partial/failed publish still returns **HTTP 200** with the outcomes.

**Error codes:** `EMPTY_RELEASE` (422), `ALREADY_PUBLISHED` (409),
`RELEASE_IMMUTABLE` (409, editing a published release's items), `ITEM_NOT_FOUND`
(404), `REVISION_STAGED` (409, pinning an uncommitted revision),
`VALIDATION_FAILED` (422, incl. `publishAt` in the past). Per-item publish
blockers surface as outcome reasons `EDITORIAL_GATE_REQUIRED` / `ITEM_DELETED`.

Scheduled releases publish via the shared `content-scheduler` tick
(`sweepDueReleases`) — idempotent and `maintenanceWindow`-aware.

---

## 4. Permissions, Roles & Policies

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/permissions/me` | Effective permission matrix for current user |
| `POST` | `/api/v1/permissions/check` | Debug: evaluate a policy rule |
| `GET/POST/PATCH/DELETE` | `/api/v1/roles` | Role CRUD |
| `GET/POST/PATCH/DELETE` | `/api/v1/policies` | Policy CRUD |
| `GET/POST/DELETE` | `/api/v1/policies/:id/permissions` | Permission rules in a policy |
| `POST` | `/api/v1/policies/:id/attach` | Attach policy to a role, user, or team |

**Permission rule shape:**
```json
{
  "collection": "articles",
  "action": "read",
  "fields": ["id", "title", "status"],
  "conditions": { "status": { "_eq": "published" } }
}
```

---

## 5. Users & Teams

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/api/v1/users` | List / create users |
| `GET/PATCH/DELETE` | `/api/v1/users/:id` | Get / update / delete user |
| `POST` | `/api/v1/users/invite` | Send invitation email |
| `POST` | `/api/v1/users/:id/impersonate` | Impersonate (admin only) |
| `GET` | `/api/v1/users/:id/sessions` | List active sessions |
| `DELETE` | `/api/v1/sessions/:id` | Revoke a session |
| `GET/POST/PATCH/DELETE` | `/api/v1/teams` | Team CRUD |

---

## 6. Files & Assets

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/files/upload-url` | Get presigned R2/S3 PUT URL |
| `POST` | `/api/v1/files` | Register file metadata after upload |
| `GET` | `/api/v1/files` | List files (filterable) |
| `GET` | `/api/v1/files/:id` | File metadata |
| `PATCH` | `/api/v1/files/:id` | Update metadata (title, tags, folder) |
| `DELETE` | `/api/v1/files/:id` | Delete file |
| `GET` | `/api/v1/assets/:id` | Serve/transform image (query params below) |

**Image transform params for `/api/v1/assets/:id`:**
```
?width=800&height=600&format=webp&quality=80&fit=cover
```

---

## 7. Flows / Automation

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/flows` | List flows (filter by `status`, `trigger`) |
| `POST` | `/api/v1/flows` | Create a new flow |
| `GET` | `/api/v1/flows/:id` | Get flow detail + graph |
| `PATCH` | `/api/v1/flows/:id` | Update flow (graph, status, options) |
| `DELETE` | `/api/v1/flows/:id` | Delete flow |
| `POST` | `/api/v1/flows/:id/run` | Manual trigger with body as input |
| `GET` | `/api/v1/flows/:id/runs` | Execution history |
| `GET` | `/api/v1/flows/:id/runs/:runId` | Single run detail (steps output) |

**Trigger a flow:**
```bash
POST /api/v1/flows/flw_abc123/run
Content-Type: application/json
Authorization: Bearer <token>

{ "userId": "usr_xyz", "action": "welcome" }
```

**Response:**
```json
{
  "data": {
    "runId": "run_def456",
    "status": "running",
    "startedAt": "2026-06-07T00:00:00Z"
  }
}
```

---

## 8. AI Copilot

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/ai/chat` | Send natural-language instruction to AI Copilot |
| `GET` | `/api/v1/ai/approvals` | List pending HITL approvals |
| `POST` | `/api/v1/ai/approvals/:id/decide` | Approve or reject a pending action |
| `GET` | `/api/v1/ai/conversations` | List conversation history |
| `GET` | `/api/v1/ai/conversations/:id/messages` | Get messages in a conversation |
| `DELETE` | `/api/v1/ai/conversations/:id` | Delete a conversation |

**Chat request:**
```json
{ "message": "Create a collection called 'products' with title, price, and status fields" }
```

**Safe skill response:**
```json
{
  "data": {
    "status": "executed",
    "data": { "collectionName": "products", "fieldsCreated": 3 }
  }
}
```

**HITL required (dangerous skill) response:**
```json
{
  "data": {
    "status": "pending_approval",
    "approvalId": "apr_ghi789",
    "message": "Creating a collection requires admin approval."
  }
}
```

**Decide on an approval:**
```json
{ "decision": "approved" }
```

### Agent API (Content OS)

All routes mount under the authenticated chain; the token's roles are the capability set.

| Method | Path | Description |
|--------|------|-------------|
| `GET/POST` | `/api/v1/agent/goals` | List / create goals (`execution: 'async'` enqueues a queued run) |
| `POST` | `/api/v1/agent/goals/:id/decompose` | Planner: create role-scoped sub-goals inheriting remaining budget |
| `POST` | `/api/v1/agent/goals/:id/settle` | Settle a parent goal from its children's terminal states |
| `GET/POST/PATCH/DELETE` | `/api/v1/agent/roles[/:name]` | Agent role library CRUD (admin) — seeded with Planner, Writer, … |
| `GET` | `/api/v1/agent/autonomy` | Trust ledger: grants + open incidents |
| `GET/POST` | `/api/v1/agent/autonomy/promotions[...]` | Promotion proposals; `POST :id/decide` is the only path to a higher level (admin) |
| `GET/POST` | `/api/v1/agent/staged[...]` | Veto window: pending stagings enriched with `approvalId/collection/itemId/patch/agentRole` from the staging revision (null fields when the staging is gone); `POST :id/veto` discards a staging |
| `POST` | `/api/v1/agent/approvals/:id/agent-decide` | Agent-as-reviewer decision (needs `review:<domain>`; self-review forbidden) |
| `GET/POST` | `/api/v1/agent/constitution[...]` | Versions, draft, `/compile` (NL→evaluators), `:id/dry-run`, `:id/activate` |
| `GET/POST` | `/api/v1/agent/kill-switch[/lift]` | Four-scope stop (`run/intent/role/site`); freezes need `agents:freeze` |
| `*` | `/api/v1/agent/intents[...]` | Content intents CRUD, `:id/pause|resume|scan|drifts`, `/compile` |
| `POST` | `/api/v1/mcp` | MCP server (Streamable HTTP, JSON-RPC 2.0) — gated by `contentOs.mcp` flag |
| `GET/DELETE` | `/api/v1/items/:collection/:id/pins[/:field]` | Law Zero pins: list / release |
| `GET` | `/api/v1/deliver/llms.txt/:site_id` | Public llms.txt index per site |

---

## 9. Realtime (WebSocket)

**Endpoint:** `wss://api.<your-site>.lumibase.dev/api/v1/realtime`

**Auth:** Pass token in query string or first message:
```
wss://...realtime?token=<access_token>&site=<siteId>
```

**Subscribe to collection:**
```json
{ "type": "subscribe", "collection": "articles", "query": { "filter": { "status": { "_eq": "published" } } } }
```

**Server event:**
```json
{ "type": "event", "collection": "articles", "event": "update", "data": { "id": "art_001", "title": "Updated title" } }
```

**Server notification frame** (push-noti feature) — broadcast to every session
for the site (not collection-scoped):
```json
{ "type": "notification", "notification": { "id": "…", "kind": "approval", "severity": "info", "title": "…", "body": "…", "deepLink": "/mission-control/inbox?entry=approval:…", "entityId": "…", "ts": "2026-06-23T01:00:00Z" } }
```

See [features/websockets-realtime.md](../features/websockets-realtime.md) for full protocol reference.

---

## 9b. Push notifications

Web Push (VAPID) + in-app realtime for agent events. Tenant-scoped; the VAPID
key is a shared deployment resource. See
[features/push-notifications.md](../features/push-notifications.md).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/push/vapid-public-key` | Application-server public key (`404 PUSH_NOT_CONFIGURED` when unset). Same key for every tenant. |
| `GET` | `/api/v1/push/status` | `{ vapidConfigured, realtimeAvailable, subscriptions }` for the active site. |
| `POST` | `/api/v1/push/test` | Dispatch a one-off `test` notification to the active site (both transports). |
| `POST` | `/api/v1/push/subscriptions` | Upsert a browser subscription: `{ endpoint, keys: { p256dh, auth } }`. |
| `DELETE` | `/api/v1/push/subscriptions` | Remove a subscription by `{ endpoint }`. |

---

## 10. Settings

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/settings` | Get all site settings |
| `PATCH` | `/api/v1/settings` | Update multiple settings |
| `GET` | `/api/v1/settings/:key` | Get single setting by key |
| `PUT` | `/api/v1/settings/:key` | Set single setting |
| `POST` | `/api/v1/settings/export` | Export settings as JSON bundle |
| `POST` | `/api/v1/settings/apply` | Apply settings bundle |

### Site configuration

The active site's identity, branding and theme defaults live on the `sites`
row (not the key/value `settings` table). Scoped to the active tenant via the
`X-Lumi-Site` header.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/site` | Get the active site's configuration |
| `PATCH` | `/api/v1/site` | Update site identity / branding / theme (partial) |

`PATCH /api/v1/site` accepts any subset of: `name`, `displayTitle`, `siteUrl`,
`descriptor`, `domain`, `defaultLanguage`, `defaultAppearance`
(`auto`\|`light`\|`dark`), `defaultSaveAction`
(`stay`\|`return`\|`create_new` — the site-wide default save action a user's
personal preference overrides), `branding` (`{ logoUrl, faviconUrl, brandColor }`),
`themeOverrides` (`{ light, dark }` maps of whitelisted CSS tokens → `H S% L%`
values), and `customCss`. An empty string clears a nullable field. A duplicate
`domain` returns `409 { errors: [{ code: 'DOMAIN_TAKEN' }] }`.

Theme model: the site holds the global defaults; per-user appearance/theme/
language overrides (resolved client-side) take precedence.

---

## 10b. Regulated / sensitive content (admin)

Opt-in capability set (spec: `regulated-content-readiness`). All admin routes
require the `admin` role; field-level decryption additionally requires the
`read_decrypted` permission. Sensitive `pii`/`phi` field reads are recorded in
`field_access_log`; decrypt failures fail closed (`500 DECRYPTION_FAILED`) and
are audited — never a placeholder.

### Encryption — keys & envelope mode

Key **material** lives only in the runtime `KeyProvider` (Workers Secrets /
env: `ENCRYPTION_KEY_<id>` + `ENCRYPTION_ACTIVE_KEY_ID`); these surfaces record
metadata + audit and drive migrations.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/v1/admin/encryption/keys` | List configured key metadata (id/status/algo). |
| `POST` | `/api/v1/admin/encryption/keys/rotate` | Promote a provisioned key to active; retires the previous. Body `{ keyId }`. Audits `encryption_key_rotated`. `422 KEY_NOT_PROVISIONED` if the bytes are absent. |
| `POST` | `/api/v1/admin/encryption/keys/rewrap` | Re-encrypt retired-key ciphertext (and re-wrap per-record DEKs) onto the active key. Idempotent, resumable, bounded per call. |
| `GET`  | `/api/v1/admin/encryption/envelope` | Current envelope-mode setting + migration progress. |
| `POST` | `/api/v1/admin/encryption/envelope` | Toggle envelope (per-record DEK) mode. Body `{ enabled, password }` — **step-up auth** re-verifies the admin password (`401 INVALID_CREDENTIALS` on mismatch). Records `encryption.envelope`, audits `envelope_mode_changed`, enqueues the background migration and drains a bounded inline batch. |
| `POST` | `/api/v1/admin/encryption/envelope/migrate` | Drain more migration batches (resumable). Poll until `{ done: true }`. |

### Editorial review → publish

Mounted at `/api/v1/editorial`. Per-collection toggle via collection
`meta.editorialWorkflow`; `meta.requireSeparateReviewer` enforces a different
reviewer than the author. Transitions audit `editorial_transition`.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/v1/editorial/reviews` | List review requests (filter by status/assignee). |
| `POST` | `/api/v1/editorial/:collection/:id/submit-review` | Move `draft → in_review`; assign a reviewer. |
| `POST` | `/api/v1/editorial/:collection/:id/approve` | `in_review → approved` (→ publish per workflow). |
| `POST` | `/api/v1/editorial/:collection/:id/reject` | `in_review → rejected`. Body `{ reason }`. |

### GDPR erasure (dual-control)

Mounted at `/api/v1/admin/erasure`. Crypto-shreds (drops per-record DEK) or
hard-deletes `items` + `revisions` while **preserving** the tamper-evident
`data_erased` audit (no cascade). Dual-control via `erasureDualControl` setting.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/admin/erasure` | Create an erasure request. Body `{ collection, filter }` + reason. Stores a subject hash, never plaintext. |
| `POST` | `/api/v1/admin/erasure/:id/confirm` | Second-admin confirmation (dual-control). |
| `POST` | `/api/v1/admin/erasure/:id/execute` | Execute the confirmed erasure; audits `data_erased` with `recordCount`. |

### Field access log & Subject Access Request

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/v1/admin/field-access-log` | Query decrypted-read audit of `pii`/`phi` fields (never values). |
| `POST` | `/api/v1/admin/sar/export` | Subject Access Request: export one subject's decrypted records + provenance. Forces a `field_access_log` entry (Req 13.2). |

---

## 11. Extensions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/extensions` | List installed extensions |
| `POST` | `/api/v1/extensions/upload` | Upload extension bundle (multipart) |
| `POST` | `/api/v1/extensions/:id/enable` | Enable extension |
| `POST` | `/api/v1/extensions/:id/disable` | Disable extension |
| `POST` | `/api/v1/extensions/:id/capabilities` | Grant capabilities |
| `GET` | `/api/v1/extensions/ui/manifest` | UI manifest for dynamic Studio import |

---

## 11b. Email (templates, layouts, send)

Site-admin scope (`requireSiteAdmin`). Backed by the shared EmailService
(SMTP / MailChannels) + a site-scoped template/layout store. Full guide:
`docs/en/features/email-service.md`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/email/capabilities` | Transport availability + default `from` |
| `GET` | `/api/v1/email/layouts` | List layouts |
| `POST` | `/api/v1/email/layouts` | Create layout (HTML shell with `{{content}}`) |
| `PATCH` | `/api/v1/email/layouts/:id` | Update layout |
| `DELETE` | `/api/v1/email/layouts/:id` | Delete layout |
| `GET` | `/api/v1/email/templates` | List templates |
| `POST` | `/api/v1/email/templates` | Create template |
| `PATCH` | `/api/v1/email/templates/:id` | Update template |
| `DELETE` | `/api/v1/email/templates/:id` | Delete template |
| `POST` | `/api/v1/email/templates/:key/preview` | Render without sending |
| `POST` | `/api/v1/email/send` | Render (if `templateKey`) + send — extension entry point |
| `POST` | `/api/v1/email/test` | Send a one-off test mail |

`POST /api/v1/email/send` body: `{ to[], cc?, replyTo?, variables?, ` and
exactly one of `templateKey` or `inline: { subject, html?, text? }` `}`.
Returns `502 DELIVERY_FAILED`, `404 NOT_FOUND` (template), or
`503 EMAIL_NOT_CONFIGURED` (degraded mode).

---

## 12. Firebase Sync

Sync content (`items`) to a Firebase target — Cloud Firestore or Realtime Database — in real time. All endpoints require **site-scoped admin**. Firebase credentials are **write-only** (supplied on create/update, encrypted at rest with `ENCRYPTION_KEY`, never returned). See [features/firebase-sync.md](../features/firebase-sync.md).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/firebase-sync/pipelines` | List sync pipelines for the active site |
| `POST` | `/api/v1/firebase-sync/pipelines` | Create a pipeline |
| `GET` | `/api/v1/firebase-sync/pipelines/:id` | Pipeline detail (credentials omitted) |
| `PATCH` | `/api/v1/firebase-sync/pipelines/:id` | Update config / rotate credentials |
| `DELETE` | `/api/v1/firebase-sync/pipelines/:id` | Delete pipeline (cascades its log) |
| `GET` | `/api/v1/firebase-sync/pipelines/:id/log` | Recent sync attempts |
| `POST` | `/api/v1/firebase-sync/pipelines/:id/backfill` | Push all matching items to Firebase now |

**Create a pipeline (Firestore):**
```bash
POST /api/v1/firebase-sync/pipelines
Content-Type: application/json
Authorization: Bearer <token>
X-Lumi-Site: <siteId>

{
  "name": "blog-to-firestore",
  "target": "firestore",
  "projectId": "my-firebase-project",
  "credentials": {
    "project_id": "my-firebase-project",
    "client_email": "svc@my-firebase-project.iam.gserviceaccount.com",
    "private_key": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
  },
  "collections": ["articles", "authors"],
  "targetPath": "content/{collection}",
  "syncOnCreate": true,
  "syncOnUpdate": true,
  "syncOnDelete": true
}
```

For `target: "rtdb"`, `credentials` is `{ "databaseUrl": "https://<project>.firebaseio.com", "secret": "<rtdb-secret>" }`.

**Response (201):**
```json
{
  "data": {
    "id": "V1StGXR8_Z5jdHi6B-myT",
    "name": "blog-to-firestore",
    "target": "firestore",
    "status": "active",
    "projectId": "my-firebase-project",
    "collections": ["articles", "authors"],
    "targetPath": "content/{collection}",
    "syncOnCreate": true,
    "syncOnUpdate": true,
    "syncOnDelete": true,
    "lastSyncAt": null,
    "lastSyncItemCount": null,
    "createdAt": "2026-06-17T00:00:00Z",
    "updatedAt": "2026-06-17T00:00:00Z"
  }
}
```

**Backfill response:**
```json
{ "data": { "scanned": 120, "pushed": 118, "failed": 2, "truncated": false } }
```

Error codes specific to this section: `ENCRYPTION_KEY_REQUIRED` (400 — `ENCRYPTION_KEY` not configured, cannot encrypt credentials), `VALIDATION_ERROR` (400 — body / credential shape does not match the selected `target`).

---

## 12a. Translation Memory

Reusable translations feeding the MT pipeline (TM → glossary → provider).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/tm` | List entries; filters `?source=&target=&entrySource=`; paginated `?limit=&offset=` → `{ data, meta: { total, limit, offset } }` |
| `POST` | `/api/v1/tm` | Upsert a TM entry |
| `PATCH` | `/api/v1/tm/:id` | Update `targetText`/`quality`/`context`/`source` |
| `DELETE` | `/api/v1/tm/:id` | Delete an entry |
| `POST` | `/api/v1/tm/lookup` | Fuzzy match (threshold default 75, shared `TM_DEFAULT_THRESHOLD`) |
| `POST` | `/api/v1/tm/translate` | Full pipeline (TM → glossary → MT provider) |

---

## 12b. Insights (Dashboards)

User-built dashboards of aggregate panels over collections. Panel queries are
executed safely: every referenced field must be in the collection's field
whitelist and the query is scoped to the active site — no user input reaches SQL
identifiers.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/dashboards` | List dashboards |
| `POST` | `/api/v1/dashboards` | Create dashboard `{ name, icon?, color?, note? }` |
| `GET` | `/api/v1/dashboards/:id` | Get dashboard |
| `PATCH` | `/api/v1/dashboards/:id` | Update dashboard |
| `DELETE` | `/api/v1/dashboards/:id` | Delete dashboard |
| `GET` | `/api/v1/dashboards/:id/panels` | List panels |
| `POST` | `/api/v1/dashboards/:id/panels` | Create panel `{ name, type, position, query }` |
| `PATCH` | `/api/v1/dashboards/:id/panels/:panelId` | Update panel (incl. `position` for layout) |
| `DELETE` | `/api/v1/dashboards/:id/panels/:panelId` | Delete panel |
| `POST` | `/api/v1/dashboards/:id/panels/:panelId/data` | Run a panel → `{ data, meta: { executedAt, rowCount, durationMs } }` |
| `POST` | `/api/v1/dashboards/:id/panels/preview` | Dry-run a `PanelQuery` (editor preview) |

`PanelQuery` (shared contract `@lumibase/shared`): `{ collection, aggregate
(count|sum|avg|min|max), field?, groupBy?, filter? (condition rule), dateRange?,
limit? }`. `field` is required for non-`count` aggregates. A field outside the
collection whitelist returns `400 { errors: [{ code: 'INVALID_FIELD' }] }`.

---

## 13. Delivery (Public)

No `Authorization` header needed. Permission applied via `public` role.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/deliver/page/:slug` | 1-roundtrip page hydration |
| `GET` | `/api/v1/deliver/items/:collection` | Public item list |
| `GET` | `/api/v1/deliver/menu/:key` | Menu config |

---

## 14. Utility endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/utils/health` | Health check (DB, cache, storage, search, queue) |
| `GET` | `/api/v1/utils/version` | API version info |
| `POST` | `/api/v1/utils/render-template` | Render a display template server-side |
| `POST` | `/api/v1/utils/jsonata/test` | Evaluate JSONata expression |
| `GET` | `/api/v1/metrics` | Prometheus metrics (Docker mode only) |

**Health response:**
```json
{
  "data": {
    "status": "healthy",
    "checks": {
      "database": "ok",
      "cache": "ok",
      "storage": "ok",
      "search": "ok",
      "queue": "ok"
    },
    "version": "1.0.0",
    "runtime": "cloudflare"
  }
}
```

---

## 15. Rate limits

| Scope | Limit |
|-------|-------|
| Auth endpoints | 30 req/min per IP |
| Items write | 600 req/min per user |
| Items read | 6,000 req/min per user |
| File upload | 100 req/min per user |
| Realtime connections | 50 concurrent per site |
| AI Chat | 60 req/min per user |

Rate limit headers:
```
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 598
X-RateLimit-Reset: 1749254460
```

---

## 16. Versioning

Breaking changes get a new path prefix (`/api/v2`). The previous version is maintained for at least 12 months.

Send `X-Lumi-API-Version: 1` to pin to a specific API version. Default is the latest stable.
