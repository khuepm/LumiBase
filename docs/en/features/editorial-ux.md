---
sourceLang: en
version: 1
lastUpdated: 2026-11-15T19:44:49.720Z
contentHash: 08f82c2049c0e3dc
codeVerified: 2026-11-15T19:44:49.720Z
codeVerifiedHash: 08f82c2049c0e3dc
codeVerifiedClaims: 12
---

# Editorial UX

Small editor conveniences that other headless CMSs ship and editors expect:
knowing when an item was first published and whether it changed since, reading
drafts and live content in one query, copying an item, and keeping autosave out
of the revision history. They are part of epic #668.

## Publication state

Every item carries three fields next to `status`:

| Field | Meaning |
|-------|---------|
| `firstPublishedAt` | Set by the item's first publish. A later publish never moves it. |
| `publishedAt` | The most recent publish. Unpublishing keeps it, so it reads "last published at". |
| `hasUnpublishedChanges` | `true` once the data of an item that has been published is edited; the next publish sets it back to `false`. |

A write counts as a **publish** when the item becomes `published`, or when the
request body sends `status: "published"` explicitly while the item is already
live (a re-publish — what Studio's **Publish** button and a release do). The
scheduler's timed publish counts too. Saving data without changing it (a no-op
save) neither sets nor clears the flag, and editing a draft that was never
published never sets it.

Items that were already `published` before migration `0035_item_publication_state`
are backfilled with their scheduled publish time, or their last update when
they had none.

List only the modified items with `?modifiedSincePublish=true`:

```bash
curl "$API/api/v1/items/articles?modifiedSincePublish=true" \
  -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE"
```

In Studio the item editor's side panel shows **First published**, **Last
published** and a **Modified since publish** badge, and the collection list has
a **Modified since publish** toggle. GraphQL exposes the fields as
`_firstPublishedAt`, `_publishedAt` and `_hasUnpublishedChanges` (underscored so
a content field called `publishedAt` keeps its name), and the list field takes a
`modifiedSincePublish: Boolean` argument.

## Reading a publication cohort

`GET /items/:collection` and `GET /items/:collection/:id` accept
`publicationState`:

| Value | Returns |
|-------|---------|
| `live` | `published` items inside their publish window (`publishAt` reached, `unpublishAt` not yet). |
| `preview` | `draft` and `published` items — what a preview site needs. |
| `all` | No cohort filter (archived included). |

Nested relations expanded with `fields=author.*` or `deep` follow the same
cohort, so a live page never embeds a draft author. GraphQL list and `_by_id`
fields take the same argument (`publicationState: live`), and their nested
relation fields follow it.

Anonymous callers and frontend-realm users are always served `live`, whatever
they ask for: `?publicationState=preview` cannot surface drafts to the public.
Without the parameter nothing changes — RBAC alone decides what a caller reads,
as before. An unknown value is rejected with `400 VALIDATION`.

## Duplicate (save as copy)

`POST /items/:collection/:id/duplicate` creates a copy as a **draft** through
the normal create path, so the caller needs `read` on the source and `create`
on the collection, and validation, hooks, the creation revision and the change
feed all apply. Fields the caller cannot read are not copied.

```json
{ "relations": "reference", "translations": true }
```

| Option | Values | Default | Meaning |
|--------|--------|---------|---------|
| `relations` | `reference`, `deep`, `none` | `reference` | `reference` copies many-to-many links (the copy points at the same targets). `deep` also copies one level of one-to-many children onto the copy. `none` copies the item alone. Many-to-one foreign keys are plain data and are always kept. |
| `translations` | `true` / `false` | `true` | `false` keeps only one locale of every `translatable-text` field. |
| `locale` | locale code | site default | The locale kept when `translations` is `false`. |
| `overrides` | object | — | Field values set on the copy, applied last. |

Unique string fields (`unique: true`) and a field named `slug` get a suffix that
no live item holds yet: `my-post-copy`, then `my-post-copy-2`, and so on. A copy
of a copy does not stack suffixes. Other unique values (numbers, objects) are
dropped so the copy does not clash. A collection with a user-supplied primary
key gets a generated id for the copy.

The response is `201 { data: <copy>, meta: { sourceId, related } }`, where
`related` lists the ids of the copied children and junction rows per
collection, and an `item_duplicated` audit entry names the source and the copy.
In Studio, **Duplicate** in the item editor's header offers the three relation
modes and opens the copy.

## Writes without a revision

Autosave and machine writes can skip the revision row with
`PATCH /items/:collection/:id?saveRevision=false` (also `PUT`). The item, the
activity log, the change feed and realtime all update as usual; only the
revision history is left out. An explicit save without the flag records a
revision as before. Writes made by an agent always record their revision,
whatever the flag says: that revision is the agent's provenance record.

In the SDK: `client.items('articles').patchWithoutRevision(id, { data })`.

### Revision retention

A collection can cap its history in its meta:

```json
{ "meta": { "revisionRetention": { "maxRevisions": 50, "maxAgeDays": 90 } } }
```

An hourly `revision-retention` sweep (Docker at :23 past the hour; on
Cloudflare Workers with the hourly Cron Trigger) deletes, per item, revisions
beyond the newest `maxRevisions` and revisions older than `maxAgeDays`. It never
deletes an item's newest revision, a staged revision (a veto window is still
open), a revision a release pins, or an agent-authored revision. Each collection
that loses rows writes one `revision_retention_applied` audit entry.

## Release validation summary

Before a release publishes, every item it would publish is validated in full —
required fields and form-layout conditions included, against the pinned
revision's snapshot when the release pins one. `GET /releases/:id/validate`
returns the summary without publishing:

```json
{ "data": { "valid": false, "checked": 2, "items": [
  { "collection": "pages", "itemId": "p2",
    "issues": [{ "field": "body", "code": "invalid_type", "message": "Invalid input: expected string, received undefined" }] }
] } }
```

Publishing runs the same check first. An invalid item never publishes; its
outcome is `failed` with reason `VALIDATION_FAILED` and the `issues`. An
`all_or_nothing` release therefore fails as a whole while any item is invalid; a
`best_effort` release still publishes its valid items. Scheduled releases go
through the same gate.

In Studio, **Content → Releases** lists the releases. **Check** shows the
summary; each issue links to the item editor with `#field=<name>`, which scrolls
to the field, focuses it and highlights it. **Publish** stays disabled while the
last check found problems. A field inside a form-layout tab that is not open is
not focused automatically — open the tab.

## API summary

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/api/v1/items/:collection?publicationState=&modifiedSincePublish=` | Cohort and "modified since publish" filters. |
| `GET` | `/api/v1/items/:collection/:id?publicationState=` | `404` when the item is outside the cohort. |
| `PATCH`/`PUT` | `/api/v1/items/:collection/:id?saveRevision=false` | Write without a revision. |
| `POST` | `/api/v1/items/:collection/:id/duplicate` | Draft copy. |
| `GET` | `/api/v1/releases/:id/validate` | Release validation summary. |

See also [Content releases](./content-releases.md) and the
[API reference](../api/hono-api-spec.md#3-items-generic-crud).
