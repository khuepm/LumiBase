---
version: 1
lastUpdated: 2026-07-05T11:00:40.093Z
sourceLang: en
contentHash: a2fe3e3fa700797a
---

# Content Releases

A **Release** collates specific item revisions across collections into a named
bundle that publishes all at once — manually, or scheduled for a date/time. This
mirrors Directus Releases, built on LumiBase's existing items/revisions model
and the content-scheduler queue.

## Lifecycle

1. **Create** a release (`POST /api/v1/releases`). With no `publishAt` it starts
   `draft`; with a future `publishAt` it starts `scheduled`.
2. **Add items across collections** (`PATCH …` with `addItems`). Each entry is
   `{ collection, itemId, targetStatus?, revisionId? }`. Pin `revisionId` to
   capture a *specific* version of the item; omit it to publish the item's live
   state at publish time.
3. **Publish** — either now (`POST /api/v1/releases/:id/publish`) or
   automatically when a scheduled release comes due (handled by the shared
   `content-scheduler` tick).
4. Each item gets a **per-item outcome** (`published` | `skipped` | `failed`),
   and the release ends `published`, `partially_failed`, or `failed`.

## Atomicity

- **`all_or_nothing`** (default): a pre-flight pass checks every item is
  publishable (exists, not deleted, editorial gate satisfiable). If any item is
  blocked, **nothing** is published and the release is marked `failed` with a
  reason.
- **`best_effort`**: each item publishes independently; the release records a
  per-item outcome and ends `partially_failed` if some failed.

> **Scope of "atomic".** Atomicity is guaranteed at the application/publish
> decision level — publish delegates to the same item-update path used by a
> normal edit (editorial gate, validation, permissions, hooks, search indexing).
> Cache/CDN revalidation happens best-effort after publish and is not rolled
> back.

## Scheduling

A `scheduled` release with a due `publishAt` is published by `sweepDueReleases`
on the shared scheduler tick. The sweep is **idempotent** (a published release is
never re-published) and respects an optional `maintenanceWindow`
(`{ windows: [{ dow, start, end }] }`, UTC) — a due release outside its window
waits for the next in-window tick.

## Editorial gate

Publishing an item to `published` on a collection with `editorialWorkflow` still
requires that item to be approved. A release does not bypass review — it
publishes approved content together. Items that aren't ready surface as
`EDITORIAL_GATE_REQUIRED`.

## Limitations (v1)

- **No release-level rollback.** Deleting a release removes the bundle, not the
  published content. Per-item revision history remains, so manual per-item revert
  is still available.
- **Late-binding race.** A `release_item` with no `revisionId` publishes the
  item's live state *at publish time* — if the item is edited between adding it
  and a scheduled publish, the later edit ships. Pin a `revisionId` on scheduled
  releases when you need an exact snapshot.
- **Human/scheduled only.** Publish is initiated by a person or a schedule a
  person set — not an agent skill — so it does not go through `ai_approvals`.
