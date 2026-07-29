---
version: 1
lastUpdated: 2026-07-25T08:17:41.283Z
sourceLang: vi
translatedFrom: vi
sourceHash: a3533e728f9d8446
mtEngine: claude
syncStatus: machine-translated
codeVerified: 2026-07-25T08:17:41.283Z
codeVerifiedHash: a3533e728f9d8446
codeVerifiedClaims: 10
---

# Collection Create Modes — Roadmap Overview

> **Status:** Proposal / Roadmap (not implemented). This document is the entry point for the "pick a mode when creating a collection" proposal and the features it depends on.
>
> Label convention: ✅ already exists (verified, with a path) · ⚠ GAP (feature still missing) · `[Proposal]` future proposal.

## Goal

When starting a new collection, offer the operator one of three paths, matching how the data actually exists:

1. **View** — the standard mode: declare a schema and tick the default fields (sort, timestamps, actor, id, name, localize).
2. **Database View** — register a table/object created *outside* LumiBase; fields are auto-discovered, and an unconfigured column shows an **exclamation mark (⚠)** that you click to bootstrap its field config (the Directus approach).
3. **Flexible DB-backed view** — a flexible read/edit surface over a SQL view or table (inspired by Directus RFC [#17265](https://github.com/directus/directus/discussions/17265)), read-only for the MVP.

This proposal references several other screens/features — some of which **do not exist yet**. All of it is broken down into 3 specs with user stories, acceptance criteria and tasks, cross-referencing each other.

## Spec map

| Spec | Scope | Status | Documents |
|------|-------|--------|-----------|
| **collection-create-modes** | Mode selector, Default_Field_Catalogue, Localize_Dropdown, Localize_Field, Flexible view | `[Proposal]` | [requirements](../../../.kiro/specs/collection-create-modes/requirements.md) · [design](../../../.kiro/specs/collection-create-modes/design.md) · [tasks](../../../.kiro/specs/collection-create-modes/tasks.md) |
| **db-view-introspection** | Auto-discover DB columns, the ⚠ marker, bootstrap-on-click into a `fields` record, Type_Map | ⚠ GAP | [requirements](../../../.kiro/specs/db-view-introspection/requirements.md) · [design](../../../.kiro/specs/db-view-introspection/design.md) · [tasks](../../../.kiro/specs/db-view-introspection/tasks.md) |
| **tenant-localization-config** | Tenant_Locales source of truth + Settings → Languages UI + editing Admin_Path | ⚠ GAP | [requirements](../../../.kiro/specs/tenant-localization-config/requirements.md) · [design](../../../.kiro/specs/tenant-localization-config/design.md) · [tasks](../../../.kiro/specs/tenant-localization-config/tasks.md) |

## Current codebase state (verified)

| Component | Status | Location |
|---|---|---|
| Collection creation wizard (5 steps) | ✅ | [`apps/studio/src/modules/data-model/wizard.tsx`](../../../apps/studio/src/modules/data-model/wizard.tsx) |
| Field inspector (Field/Interface/Display/Validation/Conditions/Layout/Storage tabs) | ✅ | [`apps/studio/src/modules/data-model/field-inspector.tsx`](../../../apps/studio/src/modules/data-model/field-inspector.tsx) |
| `collections` table (has `storage_mode`, `primary_key_type`) | ✅ | [`packages/database/src/schema/cms.ts:47`](../../../packages/database/src/schema/cms.ts) |
| `fields` table (all metadata in one row: interface/display/options/validation/conditions/classification) | ✅ | [`packages/database/src/schema/cms.ts:88`](../../../packages/database/src/schema/cms.ts) |
| Field upsert endpoint `PUT /collections/:name/fields/:field` | ✅ | [`apps/cms/src/routes/collections.ts:210`](../../../apps/cms/src/routes/collections.ts) |
| Site config `GET/PATCH /api/v1/site` + `sites.default_language` | ✅ | [`apps/cms/src/routes/site.ts`](../../../apps/cms/src/routes/site.ts) · [`packages/database/src/schema/core.ts:36`](../../../packages/database/src/schema/core.ts) |
| `translations` table (ui/field/content namespaces) | ✅ | [`packages/database/src/schema/platform.ts:97`](../../../packages/database/src/schema/platform.ts) |
| **Available locales / Tenant_Locales** | ⚠ GAP | No table or API; falls back to a hard-coded `['en','vi']` in [`translations/index.tsx`](../../../apps/studio/src/modules/translations/index.tsx) |
| **Field-level content localization** (`text-localized` / `item_translations`) | ⚠ GAP | Only UI/label translations exist, not multilingual item-level values → needs an ADR |
| **DB introspection / ⚠ marker / field bootstrap** | ⚠ GAP | Absent; fields are only read from the `fields` table |
| **Editing Admin_Path after setup** | ⚠ GAP | Only settable at `/setup/path`, not editable from settings |

## Missing features — user story summary

Every missing feature has a user story + acceptance criteria in its corresponding spec:

- **Tenant language configuration UI** → tenant-localization-config Req 1–3.
- **Editing site name / domain / admin path from Settings** → tenant-localization-config Req 3.
- **Field-level content localization** → collection-create-modes Req 5 (needs an ADR before any code).
- **DB auto-discovery + ⚠ marker + field bootstrap** → db-view-introspection Req 1–4.
- **Flexible read-only DB view collection** → collection-create-modes Req 6.

## Proposed implementation order

```
Phase 0 (decisions): field-localization ADR · settle the Tenant_Locales source · settle the introspection contract
Phase 1: tenant-localization-config (the foundation for Localize_Dropdown)
Phase 2: collection-create-modes — mode selector + View_Mode default fields (no migration needed)
Phase 3: db-view-introspection (introspection + ⚠ marker + bootstrap)
Phase 4: collection-create-modes — DB_View_Mode + Flexible_View_Mode (needs a manual migration)
```

## Definition of Done

Three rows (#33–#35) have been recorded in the Setup Impact Registry [`.kiro/specs/admin-setup-wizard/setup-impact.md`](../../../.kiro/specs/admin-setup-wizard/setup-impact.md) as required by [`.kiro/steering/definition-of-done.md`](../../../.kiro/steering/definition-of-done.md).

## External references

- Directus — Configuring fields: https://directus.com/docs/guides/data-model/fields#configuring-fields
- Directus RFC — Views as collections: https://github.com/directus/directus/discussions/17265
