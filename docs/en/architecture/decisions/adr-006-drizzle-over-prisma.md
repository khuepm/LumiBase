---
version: 1
lastUpdated: 2026-07-05T10:56:37.166Z
sourceLang: en
contentHash: e5dad22e7ceea328
---

# ADR-006: Drizzle ORM over Prisma

**Date:** 2024-01-25
**Status:** Accepted

## Context

LumiBase needs an ORM for PostgreSQL with these requirements:

1. **Works in Cloudflare Workers** — Prisma historically required a query engine binary and Node.js APIs; its edge-compatible `@prisma/adapter-pg` / `neon` adapter was in early preview at design time.
2. **Supports raw SQL / JSONB queries** — LumiBase's data model stores collection field configs and permission rules as JSONB. Complex queries need `jsonb_array_elements`, custom operators (`@>`, `?`), and raw expression support.
3. **Fully type-safe** — schema changes should produce TypeScript compile errors where query shapes are wrong.
4. **Schema-first and migration-friendly** — migrations need to be generated from schema changes and run in a controlled manner (not auto-applied on startup).

Frameworks evaluated:
- **Prisma** — mature, great DX, but edge runtime support was unstable; Rust query engine not compatible with Workers
- **Kysely** — query builder, not a full ORM; no migrations
- **Drizzle** — schema-first, generates SQL migrations, no query engine binary, works in Workers via `postgres.js` HTTP mode
- **MikroORM** — Node.js-specific, not Workers-compatible

## Decision

Use **Drizzle ORM** (`drizzle-orm` + `drizzle-kit`) with the `postgres.js` driver.

Schema lives in `packages/database/src/schema/`, organized into files:
- `core.ts` — sites, settings
- `access.ts` — roles, policies, permissions, users, teams
- `cms.ts` — collections, fields, relations, items, revisions, activity
- `platform.ts` — files, webhooks, extensions, presets, flows, operations
- `ai.ts` — ai_approvals, ai_conversations, ai_messages
- `search.ts` — search indexes

Migration SQL is generated via `drizzle-kit generate` and applied via `drizzle-kit migrate`. Migrations are committed to `packages/database/src/migrations/`.

## Consequences

**Positive:**
- Zero external dependencies at runtime — no binary query engine, no JIT compilation
- Works in Workers via `postgres.js` in HTTP/WebSocket mode (compatible with Hyperdrive)
- Full TypeScript inference from schema → query results
- Fine-grained SQL control when needed (`sql<string>` escape hatch)
- Migration files are plain SQL — reviewable, reversible, and deployable via CI

**Negative:**
- Less mature ecosystem than Prisma — fewer community resources and third-party plugins
- No built-in soft-delete or audit hooks (implemented manually in `RevisionService` and `ActivityService`)
- Schema definition syntax is more verbose than Prisma's (`schema.prisma` DSL is more concise)
- Drizzle relations API (for nested queries) has a learning curve and occasional edge cases with complex JSONB queries

**Neutral:**
- `packages/database` exports both the Drizzle schema and a typed `db` instance; apps import from `@lumibase/database`
