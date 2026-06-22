# Hono API Specification — LumiBase

> **For AI agents:** This page is also available as clean Markdown. Append `/index.md` to any LumiBase docs URL.
>
> **Base URL:** `https://api.<your-site>.lumibase.dev` (or `http://localhost:1989` in local dev)
>
> All endpoints are versioned under `/api/v1`. Every request must include:
> - `Authorization: Bearer <access_token>` — JWT from Logto or local auth
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
| `filter` | `filter[status][_eq]=published` | Filter using rule operators |
| `sort` | `sort=-updated_at,title` | Comma-separated, `-` prefix for DESC |
| `page` | `page=2` | Page number (1-indexed) |
| `limit` | `limit=25` | Items per page (max 200) |
| `search` | `search=lumibase` | Full-text search on searchable fields |
| `aggregate[count]` | `aggregate[count]=*` | Aggregate functions |
| `groupBy` | `groupBy=status` | Group aggregation results |
| `deep` | `deep[author][fields]=name,avatar` | Nested relation query params |

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

---

## 1. Auth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/auth/login` | Exchange Logto auth code or username/password for access + refresh tokens |
| `POST` | `/api/v1/auth/refresh` | Refresh expired access token |
| `POST` | `/api/v1/auth/logout` | Revoke tokens |
| `GET` | `/api/v1/auth/me` | Get current user profile |

**Login request:**
```json
{
  "email": "admin@example.com",
  "password": "your-password"
}
```

**Login response:**
```json
{
  "data": {
    "access_token": "eyJ...",
    "refresh_token": "...",
    "expires_in": 3600,
    "user": {
      "id": "usr_abc123",
      "email": "admin@example.com",
      "role": "administrator"
    }
  }
}
```

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

See [features/websockets-realtime.md](../features/websockets-realtime.md) for full protocol reference.

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
(`auto`\|`light`\|`dark`), `branding` (`{ logoUrl, faviconUrl, brandColor }`),
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
