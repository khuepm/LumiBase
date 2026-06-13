# Physical and External Collections

Status: decision record for Directus Data Model Parity.

## Decision

Defer general-purpose `physical` and `external` collection modes for the current POST-GA8 parity phase. Keep `jsonb` as the default source of truth and use `materialized` projections as the performance bridge.

This keeps schema changes fast and portable across Cloudflare and Docker runtimes while still making storage tradeoffs explicit in Studio and schema diffs.

## Current Contract

| Mode | Ownership | Source of truth | Runtime writes | Current status |
|---|---|---|---|---|
| `jsonb` | LumiBase logical schema | `items.data` JSONB | ItemService writes JSONB | Implemented default |
| `materialized` | LumiBase logical schema plus managed projection | JSONB | ItemService writes JSONB, projection refreshes separately | Implemented as opt-in optimization |
| `physical` | LumiBase owned table | Physical table | Future DDL-backed writes | Reserved |
| `external` | External database/table owner | External table | Future introspected access | Reserved |

Schema diff marks changes to `storageMode`, primary key strategy, destructive field changes, and relation topology as runtime-impacting. Studio surfaces those risks before `PUT /collections/:name/schema` applies changes.

## Why Defer Physical Tables

Directus-style physical tables are valuable for SQL compatibility, database-native constraints, and easier external reporting. They also require a real migration engine rather than metadata-only schema updates.

The missing pieces are substantial:

- tenant-safe table naming and collision avoidance;
- online DDL strategy per runtime and database adapter;
- rollback for failed field, relation, and index migrations;
- generated integer and big integer sequences per collection;
- physical relation constraints, junction tables, and `onDelete` semantics;
- per-field index/unique DDL with safe rebuild paths;
- item API routing between JSONB, materialized projection, physical table, and external table;
- typegen/OpenAPI contract for storage-specific behavior;
- backup and disaster recovery behavior for owned physical tables.

Shipping a partial DDL engine would make schema apply look more Directus-like while increasing the chance of half-applied migrations. POST-GA8 therefore treats `physical` and `external` as explicit future modes, not hidden behavior.

## Tenant Isolation Options

If `physical` mode is implemented later, choose one of these patterns:

| Option | Shape | Pros | Cons |
|---|---|---|---|
| Table prefix | `lb_<siteId>_<collection>` | Simple with one schema; works on most Postgres setups | Long names, harder grants, noisy namespace |
| Schema per site | `<siteId>.<collection>` | Clear isolation, easier cleanup | Requires schema grants and adapter support |
| Shared typed table | One table per logical shape | Efficient for repeated templates | Hard to map arbitrary custom schema |

Recommended future default: schema per site when the runtime/database supports it, with table prefix fallback for constrained environments.

## External Table Rules

`external` mode should be read-first until the integration can prove safe writes.

Required guardrails:

- introspection must record immutable table identity, primary key, nullable fields, and relation candidates;
- LumiBase must not issue destructive DDL for external tables;
- `onDelete: cascade` and `set null` must be blocked unless the external owner exposes a compatible constraint contract;
- schema apply must produce a diff but require an explicit migration adapter for writes;
- permission checks still run in LumiBase even if data comes from an external source.

## Migration Path

1. Keep author-created collections in `jsonb` by default.
2. Add or refresh `materialized` projections for hot reads.
3. For future `physical`, implement a planner that converts schema diff into DDL steps before any apply.
4. Require dry-run output with estimated locks, rollback plan, and affected indexes.
5. Only then allow `storageMode: physical` as an executable migration rather than a reserved badge.

## Acceptance Criteria For Future Implementation

- `schema.diff` includes DDL steps, lock risk, rollback strategy, and data migration requirements.
- `schema.apply` runs all DDL/data changes transactionally where supported and fails closed otherwise.
- Item create/update/read/delete route through the correct storage backend without changing permission semantics.
- Typegen reflects physical primary key types, generated fields, nullable fields, and relation-expanded responses.
- Studio shows storage-specific badges and blocks unsupported primary key/index/relation combinations.

Until these criteria are met, `jsonb` and `materialized` are the supported production modes.
