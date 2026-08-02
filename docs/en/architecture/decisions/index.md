---
version: 1
lastUpdated: 2026-07-05T10:56:36.955Z
sourceLang: en
contentHash: fa73f811c20a5c31
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
