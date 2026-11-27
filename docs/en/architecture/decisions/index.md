---
version: 7
lastUpdated: 2026-11-26T02:34:33.783Z
sourceLang: en
contentHash: 08c209570ccf65cc
---

# Architecture Decision Records (ADR)

LumiBase follows the [ADR pattern](https://adr.github.io/) to document significant architectural decisions. Each ADR captures the context, decision, and consequences in a lightweight format.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](./adr-001-nanoid-over-uuid.md) | Use NanoID / UUIDv7 over auto-increment | Accepted |
| [ADR-002](./adr-002-runtime-abstraction.md) | Runtime Abstraction Layer for Dual Deployment | Accepted |
| [ADR-003](./adr-003-hitl-for-dangerous-ai-skills.md) | Human-in-the-Loop for Dangerous AI Skills | Accepted |
| [ADR-004](./adr-004-tag-based-cache-invalidation.md) | Tag-based Cache Invalidation | Accepted |
| [ADR-005](./adr-005-hono-over-express.md) | Hono.js over Express/Elysia | Accepted |
| [ADR-006](./adr-006-drizzle-over-prisma.md) | Drizzle ORM over Prisma | Accepted |
| [ADR-007](./adr-007-logto-for-auth.md) | Logto for Authentication | Accepted |
| [ADR-008](./adr-008-policy-dsl-json.md) | JSON Policy DSL for Permissions | Accepted |
| [ADR-009](./adr-009-graphql-yoga.md) | GraphQL Yoga with Dynamic Schema over ItemService | Accepted |
| [ADR-010](./adr-010-lumibase-table-prefix.md) | `lumibase_` prefix for all system tables | Accepted |
| [ADR-011](./adr-011-user-management-realms.md) | User Management Realms (single store, role-scoped realms, token audiences) | Accepted |
| [ADR-012](./adr-012-remove-cdc-cache-invalidator.md) | Remove CDC CacheInvalidator (superseded by tag purge at API write path) | Accepted |
| [ADR-013](./adr-013-organization-plane.md) | Organization plane (tenant hierarchy and scope-typed credentials) | Proposed |
| [ADR-014](./adr-014-preview-bridge-threat-model.md) | Live preview bridge — preview tokens, framing and postMessage threat model | Accepted |
| [ADR-015](./adr-015-extension-isolation.md) | Extension code isolation (out-of-process host on Node; Workers stay in process) | Accepted |
| [ADR-016](./adr-016-governed-retrieval.md) | Governed retrieval (evidence-driven engine choice; PostgreSQL source of truth, Meili hybrid first) | Proposed |

## Template

When adding a new ADR, use this template:

```markdown
# ADR-NNN: Title

**Date:** YYYY-MM-DD
**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNN

## Context
...

## Decision
...

## Consequences
...
```
