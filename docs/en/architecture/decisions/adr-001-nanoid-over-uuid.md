# ADR-001: Use NanoID / UUIDv7 over Auto-increment

**Date:** 2024-01-15
**Status:** Accepted

## Context

LumiBase is a multi-tenant SaaS platform where:

1. **Multiple sites share the same database** — if collections across different sites both use auto-increment IDs, a `UNION` or cross-site query could expose data from another tenant through ID enumeration attacks (attacker guesses `id=123` to find records from other sites).

2. **Edge deployment with distributed workers** — Cloudflare Workers runs in 200+ data centers globally. Auto-increment requires a single authoritative sequence source; with connection pooling via Hyperdrive, sequence generation creates contention and latency.

3. **Config-as-Code export/import** — when exporting a collection's config (schema, sample data, permissions) to YAML/JSON for GitOps, records need stable, portable IDs that don't conflict when imported into another environment.

4. **Directus parity** — Directus uses UUIDs for system tables. LumiBase aims to be migration-compatible.

## Decision

All primary keys in LumiBase use **NanoID** (21-character URL-safe strings, `~2.1M IDs/second` with collision probability `< 1%` after 1 billion IDs) for domain records, and **UUIDv7** for system/audit tables where time-ordering matters.

Rules:
- **NanoID** — user content (items, collections, fields, relations, users, files, flows, extensions)
- **UUIDv7** — system tables (activity, revisions, ai_approvals, ai_messages) where chronological ordering by primary key is useful
- **No serial/auto-increment** — anywhere in domain or system tables

IDs are generated at the application layer (not the database), using:
- `nanoid()` from the `nanoid` package (Node.js) or `crypto.getRandomValues` shim (CF Workers)
- `uuidv7()` from the `uuidv7` package

## Consequences

**Positive:**
- Eliminates ID enumeration security risk across tenants
- Works without a central sequence generator — compatible with distributed edge deployment
- IDs are portable across environments (dev → staging → prod)
- Human-readable in URLs and logs (NanoID: `art_Mk3qp7` vs UUID: `550e8400-e29b-41d4-a716-446655440000`)

**Negative:**
- Slightly more storage than integer PKs (21 chars vs 4-8 bytes)
- No guaranteed ordering by ID (mitigated: use `created_at` for ordering)
- Application must generate IDs (cannot use DB DEFAULT for inserts without explicit ID)

**Neutral:**
- Foreign keys are `text` type in Drizzle schema, not `integer` — slightly larger join overhead (acceptable at expected data volumes)
