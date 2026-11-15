---
sourceLang: en
version: 4
lastUpdated: 2026-11-15T15:29:22.118Z
contentHash: d25424a17a2f2579
codeVerified: 2026-11-15T15:29:22.118Z
codeVerifiedHash: d25424a17a2f2579
codeVerifiedClaims: 22
---

# Hierarchical collections

A collection can store its items as a **tree**: every item may have a parent in
the same collection, and Studio shows the collection as an expandable outline
(pages under sections, categories under categories, docs under folders). Moving
an item moves its whole subtree. Combined with a policy that grants `read` and
`update` but not `create` or `delete`, the tree becomes a fixed folder
structure that editors can fill in and rearrange but not grow or prune
("folder mode").

## Turning it on

Set `meta.tree` on the collection — in Studio under **Data model → collection →
Raw JSON** (schema apply), or through the collections API:

```json
{ "meta": { "tree": { "enabled": true, "maxDepth": 4, "onDelete": "restrict" } } }
```

| Option | Values | Default | Meaning |
|--------|--------|---------|---------|
| `enabled` | `true` / `false` | — (required) | Turns tree behaviour on. |
| `maxDepth` | integer `1`–`32` | `32` | Deepest level allowed; a root is depth 1. Enforced on create and on move (for the deepest descendant of the moved subtree). |
| `onDelete` | `restrict`, `cascade`, `reparent` | `restrict` | What deleting an item that still has children does. See [Deleting a parent](#deleting-a-parent). |

An invalid `meta.tree` is rejected with `400 INVALID_TREE_CONFIG` by collection
create, update and schema apply (`PUT /api/v1/collections/{name}/schema`). Turning the tree off later keeps the stored
structure; tree endpoints then answer `400 TREE_NOT_ENABLED`.

Items that existed before the tree was enabled (and items written by bulk
create) have no parent and read as roots. Nothing is backfilled.

## How the tree is stored

Each item row in `lumibase_items` gets two columns (migration
`packages/database/drizzle/0032_item_tree.sql`):

- `parent_id` — the parent item's id, `NULL` for a root;
- `path` — the materialised chain of ids from the root down to the item itself,
  for example `/root/section/page/`.

Both are maintained by the server only; clients never write `path`. Children
are ordered by the existing `sort` column. Every write that derives one path
from another (create under a parent, move, a `cascade`/`reparent` delete) runs
in one transaction that holds a per-collection advisory lock, so concurrent
moves are serialised and cannot corrupt the tree. Item rows returned by the
items API carry `parentId` and `path`.

A parent is always an item of the same site and the same collection. There is
no database foreign key on `parent_id`: every tree read and write looks items
up by `site_id`, `collection_id` and `id` together, never by id alone, so the
tree stays correct whether item ids are unique per instance or only per site.
An id that belongs to another site answers `404`, exactly like an id that does
not exist.

## API

All routes are under `/api/v1/items/{collection}` and need the usual
permission for the action.

### Create under a parent

```http
POST /api/v1/items/pages
{ "data": { "title": "Install" }, "parentId": "k3J9x…" }
```

`parentId` is optional (absent or `null` = root). The parent must exist in the
same collection and be **readable** by the caller, otherwise `404 PARENT_NOT_FOUND`.
Without an explicit `sort` the new item is appended after its
siblings. `400 TREE_NOT_ENABLED` on a flat collection, `409 TREE_MAX_DEPTH` when
the parent is already at `maxDepth`.

### Read the tree

The list endpoint takes a `tree` mode. Filters, `fields`, `limit`/`offset` and
`status` still apply; without `sort` the order is the tree order.

| Query | Returns | Default order |
|-------|---------|---------------|
| `?tree=children&parent={id}` | Direct children of `{id}`. `parent` absent, empty or `null` = the roots. | `sort`, then creation time |
| `?tree=subtree&parent={id}` | Every descendant of `{id}` (not `{id}` itself). Without `parent`: the whole tree. | depth, then `sort` |
| `?tree=ancestors&node={id}` | The ancestors of `{id}`, root first. | depth |

```http
GET /api/v1/items/pages?tree=children&parent=null
GET /api/v1/items/pages?tree=subtree&parent=k3J9x…&fields=title
GET /api/v1/items/pages?tree=ancestors&node=Zp0q…
```

A malformed tree query (`tree=ancestors` without `node`, `parent` without
`tree`) is `400 VALIDATION`.

### Move a subtree

```http
POST /api/v1/items/pages/{id}/move
{ "parentId": "k3J9x…", "position": 0 }
```

- `parentId` — the new parent, or `null` to make the item a root.
- `position` — optional 0-based index among the new siblings. The siblings are
  renumbered `0..n-1` (only their `sort` changes). Without it, the item keeps
  its `sort` when the parent does not change and is appended otherwise.

Reordering inside one parent is a move to the same parent with a `position`.
The whole subtree's paths are rewritten in the same transaction. Responses:

| Status | Code | When |
|--------|------|------|
| `200` | — | `{ "data": { "id", "parentId", "path", "sort" } }` |
| `404` | `NOT_FOUND` | The item does not exist or the caller's `update` rule does not match it. |
| `404` | `PARENT_NOT_FOUND` | The new parent does not exist or is not readable by the caller. |
| `409` | `TREE_CYCLE` | The new parent is the item itself or one of its descendants. |
| `409` | `TREE_MAX_DEPTH` | The deepest item of the subtree would go past `maxDepth`. |

A move needs `update` on the moved item. With `position`, the caller's
`update` field whitelist must include `sort`.

### Deleting a parent

`DELETE /api/v1/items/{collection}/{id}` follows the collection's `onDelete`:

- `restrict` (default) — refused with `409 TREE_HAS_CHILDREN` while the item has
  live descendants. Move or delete them first.
- `cascade` — the item and its whole live subtree are soft-deleted together.
  Every descendant must also pass the caller's `delete` rule; if one does not,
  nothing is deleted (`403 FORBIDDEN`).
- `reparent` — the item's children move up to its parent (or become roots) and
  their subtrees' paths are rewritten.

## Permissions and hidden items

Row rules apply to every tree query, so the tree never returns data the caller
could not read through the flat list:

- the anchor of a query (`parent`, `node`) must be readable, otherwise `404` —
  the same answer as for an id that does not exist;
- every row returned passes the caller's `read` rule; a hidden ancestor is simply
  missing from an `ancestors` answer and a hidden item is missing from
  `children`/`subtree`;
- a hidden parent cannot be used as a target for create or move
  (`PARENT_NOT_FOUND`).

**Decision:** a readable item's `parentId` and `path` are returned as stored,
even when they name items the caller cannot read. They are opaque ids — no
field of the hidden item is exposed — and redacting them would make the
structure of the readable items inconsistent. In Studio the tree is loaded
level by level from the roots, so a hidden item and everything under it does
not appear there; such descendants are still reachable through the table view
if they are readable.

## Folder mode

The policy model already grants each action per collection, so "folder mode"
needs no extra setting: give the editors' policy `read` and `update` on the
collection and leave out `create` and/or `delete` (**Access → Policies**). The
API then answers `403 FORBIDDEN` to create/delete, while browsing, editing and
moving work. Studio follows the same permission bundle
(`GET /api/v1/permissions/me`):

- without `create`: no **New item** button, no **Add child** action in the tree,
  and **Import** is disabled;
- without `delete`: no **Delete** button in the item editor;
- without `update`: the tree has no move / indent / outdent buttons;
- expanding the tree and opening items always works with `read`.

## Studio

For a tree collection, **Content → collection** opens in the **Tree** view
(a **Table** toggle shows the flat list). Each level loads when it is expanded.
With `update`, each row has **Move up / Move down** (reorder among siblings),
**Indent** (nest under the previous sibling) and **Outdent** (move up one level,
right after the old parent). With `create`, **Add child** opens the new-item form
with the parent preset.

## Multi-tenancy

Nothing is shared between sites. `parent_id` and `path` live on the site's own
item rows; every tree read and write is scoped by `site_id` and the collection,
so a parent id from another site is answered `404 PARENT_NOT_FOUND`. The advisory
lock key contains the site id and the collection id, so writers of different
sites (or collections) never wait on each other. The DB integration suite
`apps/cms/src/services/__tests__/item-tree.db.integration.test.ts` checks both
the site scoping and the concurrent-move behaviour against PostgreSQL.

## Source

- `apps/cms/src/services/tree-service.ts` — config validation, path helpers, the tree lock.
- `apps/cms/src/services/item-service.ts` — create/move/delete/list integration.
- `apps/cms/src/routes/items.ts` — `tree` list params and the move route.
- `apps/studio/src/modules/content/tree-view.tsx` — Studio tree view.
