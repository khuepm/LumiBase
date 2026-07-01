# ADR-010: `lumibase_` prefix for all system tables

**Date:** 2026-07-01
**Status:** Accepted

## Context

LumiBase stores no-code content as JSONB rows in a generic `items` table, but the
Phase-2 **materialization** feature (`apps/cms/src/services/materialize-service.ts`)
dynamically creates *physical* Postgres tables named after user collections
(`mat_<id>`). System tables (`users`, `sites`, `items`, `agent_runs`, …) lived in
the same `public` schema with no marker distinguishing platform-owned tables from
anything a tenant might cause to be created. That ambiguity is a latent collision
and security-reasoning hazard: there was no single rule to answer "is this table
ours or the user's?".

Only two tables already carried a prefix (`lumibase_firebase_sync_*`), set as an
ad-hoc precedent with no documented convention.

## Decision

Prefix **every** system table with `lumibase_`, applied uniformly — including
tables that already had semantic sub-prefixes (`agent_*`, `ai_*`, `cdc_*` →
`lumibase_agent_*`, `lumibase_ai_*`, `lumibase_cdc_*`). This yields one invariant:

> A table whose name starts with `lumibase_` is platform-owned. Any other table
> is user-created (or a `mat_*` materialization).

**Name prefix, not a Postgres schema namespace.** We keep all tables in `public`
and prefix their names rather than moving them into a dedicated `lumibase` schema
via `pgSchema()`. Rationale:

- **Data-preserving migration.** A rename (`ALTER TABLE … RENAME TO`) keeps rows,
  indexes, foreign keys and sequences in place; Postgres auto-updates FK
  definitions to point at the renamed tables.
- **No `search_path` dependence.** LumiBase runs on Cloudflare Workers through
  Hyperdrive (pooled connections). A schema namespace would require a reliable
  `search_path` on every pooled connection or fully-qualified names everywhere;
  a name prefix has neither risk.
- **Simpler RLS.** The hand-written `rls-policies.sql` addresses tables by bare
  `%I`-formatted names; only the name list changes.

**Index and constraint names are left unchanged.** `ALTER TABLE RENAME` does not
rename dependent indexes/constraints, and those names are not in the
collision-prone namespace (they are not tables). Leaving them avoids churn and is
functionally harmless (e.g. `collections_site_id_sites_id_fk` still enforces the
FK on `lumibase_collections`).

## Consequences

- **Migration:** `packages/database/drizzle/0039_lumibase_prefix.sql` renames all
  80 previously-unprefixed tables, idempotently (`IF EXISTS`). Applied via the
  existing hand-authored migration workflow (`_journal.json` entry + `scripts/migrate.ts`).
- **Drizzle ORM code is unaffected.** Table `const` exports keep their names
  (`export const users = pgTable('lumibase_users', …)`), so all `references()` FKs
  and query code propagate automatically. Only raw-SQL touchpoints (RLS, seed
  scripts, `materialize-service` triggers, login-guard settings read, integration
  test `TRUNCATE`s) were updated by hand.
- **RLS re-apply required.** After migrating, re-run `rls-policies.sql` (it targets
  the new names). While updating it, a pre-existing nested `$$` dollar-quote bug in
  its `DO` block was fixed (inner tag changed to `$pol$`) so the script applies via
  `psql` at all.
- **Operators must back up before upgrading** and run migration 0039; the rename is
  lossless, so forward/rollback are both safe.
- **Drizzle snapshots (`drizzle/meta/*.json`) are not updated here.** They already
  lag the journal (latest snapshot `0031`, journal at `0038`) because the team
  hand-authors migrations; the migrator ignores snapshots. Full snapshot
  regeneration is deferred as separate maintenance.
