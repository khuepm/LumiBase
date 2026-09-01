---
version: 2
lastUpdated: 2026-08-02T19:11:08.580Z
sourceLang: vi
translatedFrom: vi
sourceHash: d5bc9b2c5e589f3f
mtEngine: manual
syncStatus: human-translated
codeVerified: 2026-08-02T19:11:08.580Z
codeVerifiedHash: d5bc9b2c5e589f3f
codeVerifiedClaims: 16
---

# LumiBase Firebase Sync

> An extension that syncs content (`items`) from LumiBase to **Firebase** — Cloud Firestore or Realtime Database — in real time, every time an item is created/updated/deleted.

Module: `apps/cms/src/modules/lumibase-firebase-sync/` · Mounted at `/api/v1/firebase-sync`.

## 1. Goal & model

Each **pipeline** configures one Firebase destination for one site. When an item in the selected collections changes, LumiBase pushes that change to Firebase (upsert or delete). One pipeline = one (site, Firebase destination, set of collections, set of actions).

- **Edge-native:** the connector uses only `fetch` + Web Crypto (REST); it does **not** use the `firebase-admin` SDK (incompatible with Cloudflare Workers).
- **Real-time:** the sync is triggered from `ItemService` right after a write (alongside `publishRealtimeEvent`), fire-and-forget — a Firebase error does **not** fail the CMS request.
- **Backfill:** push all existing items of a collection to Firebase via a dedicated endpoint.
- **Multi-tenant:** every query is scoped by `siteId`.

## 2. Two Firebase destinations

| Destination | `target` | Write | Authentication |
|---|---|---|---|
| Cloud Firestore | `firestore` | Each item → 1 document, `PATCH` (upsert) | Service-account JSON → JWT RS256 → OAuth2 access token (cached by TTL) |
| Realtime Database | `rtdb` | Each item → 1 JSON ref, `PUT` (upsert) | Legacy database secret appended via `?auth=` |

Delete treats a Firestore `404` as success (idempotent).

## 3. Credentials & security

- Firebase credentials are **encrypted at rest** (AES-GCM via `CryptoService`) using the `ENCRYPTION_KEY` environment variable, stored in the `credentials_encrypted` column.
- Credentials are **write-only**: entered when creating/updating a pipeline; **no** read endpoint ever returns them.
- All endpoints require **site-scoped admin** (`requireSiteAdmin`).
- The real-time sync hook only runs when `ENCRYPTION_KEY` is configured (credentials must be decryptable). If the key is missing, `POST /pipelines` returns `400 ENCRYPTION_KEY_REQUIRED`.

Credential blob shape:

```jsonc
// target = "firestore" — service-account JSON (the fields actually used)
{ "project_id": "...", "client_email": "...", "private_key": "-----BEGIN PRIVATE KEY-----\n..." }

// target = "rtdb"
{ "databaseUrl": "https://<project>.firebaseio.com", "secret": "<rtdb-secret>" }
```

## 4. Target path

The `targetPath` field is a template, defaulting to `{collection}`. Placeholders are interpolated at sync time:

- `{collection}` → the collection's machine-name.
- `{itemId}` → the item's id.

If the template does **not** contain `{itemId}`, the item id is appended as the last segment. Examples:

| `targetPath` | collection=`articles`, itemId=`a1` | Result |
|---|---|---|
| `{collection}` | | `articles/a1` |
| `content/{collection}` | | `content/articles/a1` |
| `content/{collection}/{itemId}` | | `content/articles/a1` |

> Each document/ref is written with a `_lumibaseItemId` field to trace back to the source item.

## 5. API

See full request/response details in [hono-api-spec.md §12](../api/hono-api-spec.md). Summary:

| Method | Path | Description |
|--------|------|-------|
| `POST` | `/api/v1/firebase-sync/pipelines` | Create a pipeline |
| `GET` | `/api/v1/firebase-sync/pipelines` | List the site's pipelines |
| `GET` | `/api/v1/firebase-sync/pipelines/:id` | Details (does not return credentials) |
| `PATCH` | `/api/v1/firebase-sync/pipelines/:id` | Update config / rotate credentials |
| `DELETE` | `/api/v1/firebase-sync/pipelines/:id` | Delete a pipeline (cascade log) |
| `GET` | `/api/v1/firebase-sync/pipelines/:id/log` | Recent sync runs log |
| `POST` | `/api/v1/firebase-sync/pipelines/:id/backfill` | Push all matching items to Firebase |

## 6. Matching a pipeline to a change

An item change is synced to a pipeline when **all** of the following hold:

1. The pipeline has `status = 'active'`.
2. `collections` is empty (every collection) **or** contains the collection's machine-name.
3. The action is enabled: `syncOnCreate` / `syncOnUpdate` / `syncOnDelete`.

Sync is best-effort per pipeline: a failing pipeline is logged and switched to `status='error'` + `statusMessage`, while the other pipelines still run.

## 7. Backfill

`POST /pipelines/:id/backfill?limit=N` scans the site's non-deleted items (`deleted_at IS NULL`), filters by the pipeline's collections, and upserts them to Firebase. `limit` defaults to 500, with a maximum of 2000 per call to stay within the Worker's CPU/time limits; paginate with repeated calls (the response returns `truncated: true` when it hits `limit`).

## 8. Storage

| Table | Description |
|---|---|
| `lumibase_firebase_sync_pipelines` | Pipeline config + encrypted credentials + `lastSyncAt`/`lastSyncItemCount` |
| `lumibase_firebase_sync_log` | Append-only: each sync (collection, itemId, action, result, errorMessage, durationMs) |

Migration: tables are created by the consolidated `packages/database/drizzle/0000_lumibase_init.sql`. See also [data-model.md](../data-model.md).

## 9. Related

- [Webhooks](../api/hono-api-spec.md) — plain HTTP event push (difference: Firebase Sync mirrors the whole item into a data store).
- [ClickHouse CDC](../cdc/README.md) — replication to an OLAP store (difference: CDC is for analytics and needs its own infrastructure; Firebase Sync is lightweight, per-pipeline via the API).
- [Extension System](./extensions-system.md) — the community extension sandbox.
