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
