---
version: 1
lastUpdated: 2026-07-08T20:22:56.250Z
sourceLang: en
contentHash: 3832be55c3103f37
---

# Versioning Policy

> Effective from **v1.0.0**. Before 1.0.0, LumiBase is under active development
> and `0.x` releases may include breaking changes in any release — only the
> latest release is supported (see [`SECURITY.md`](../../../SECURITY.md)).

LumiBase follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`)
strictly from `1.0.0` onward. This document defines what "breaking" means for
LumiBase, which parts of the system that guarantee applies to, and how features
are deprecated and removed.

## Semver rules

| Bump | Version | What it may contain | What it may **not** do |
|------|---------|---------------------|------------------------|
| **PATCH** | `1.0.x` | Bug fixes, security fixes, docs. | Change any public surface; run a data-destructive migration. |
| **MINOR** | `1.x.0` | New features; new endpoints, fields, or config (additive); additive + idempotent migrations. | Remove or change the shape of a frozen surface; require downtime. |
| **MAJOR** | `2.0.0` | Breaking changes: removed/renamed endpoints, changed response shapes, changed auth contract, migrations requiring downtime or re-install. | — |

Every release — including a patch — must pass the full CI gate (typecheck,
tests, lint, build, dependency audit, CodeQL) and, when it ships a migration,
the upgrade-path test. See [`operations/upgrades.md`](../operations/upgrades.md).

## Public surface

The following is the **public surface** covered by the semver guarantee. A
breaking change to any of these requires a major bump:

- **REST API** — all endpoints under `/api/v1`, their request params, and their
  `{ data, meta }` / `{ errors }` response envelopes
  ([`api/hono-api-spec.md`](../api/hono-api-spec.md)).
- **GraphQL API** — the schema documented in
  [`api/graphql-api-spec.md`](../api/graphql-api-spec.md).
- **SDK** — the exported signatures of `@lumibase/sdk`
  (`client`, `rest`, `graphql`, `typegen`, `realtime`, `seo`, `types`).
- **Header contracts** — `X-Lumi-Site`, `X-Lumi-API-Version`, and the
  `X-RateLimit-*` / `Retry-After` response headers.
- **Environment variables** — names and semantics of documented env vars
  (`DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `CORS_ALLOWED_ORIGINS`,
  `LUMIBASE_RUNTIME`, …).
- **CLI / setup wizard flags** — `create-lumibase` args and setup wizard steps.

**Not** part of the public surface (may change in any minor):

- Internal services and module internals (`apps/cms/src/services`, `modules/`).
- The detailed database schema and table layout (the migration *path* is
  guaranteed; the internal column shape is not).
- Studio internals (component structure, internal routes, build output).
- Anything documented as experimental, reserved, or "not yet implemented"
  (e.g. M2A relations, which return `501 RELATION_TYPE_NOT_IMPLEMENTED` and are
  reserved for a future release).

### API version pinning

Breaking REST changes ship under a new path prefix (`/api/v2`); the previous
version is maintained for **at least 12 months** after its successor is
released. Clients pin with `X-Lumi-API-Version: 1`; the default is the latest
stable version. This mirrors §16 of the [REST API spec](../api/hono-api-spec.md).

## Deprecation policy

To remove anything from the public surface:

1. **Deprecate in a minor release** — the feature keeps working, but:
   - it emits a deprecation warning (log line and/or `Deprecation` response
     header where applicable),
   - the CHANGELOG entry lists it under a `Deprecated` heading,
   - the docs mark it deprecated and point to the replacement.
2. **Remove in the next major** — at the earliest.

There must be **at least one full minor cycle** between deprecation and removal.
A feature deprecated in `1.3.0` cannot be removed before `2.0.0`, and never in a
patch or minor.

## Support window

- Security fixes are provided for the **current major** and the **immediately
  preceding major** for **6 months** after a new major ships.
- Within a supported major, only the **latest minor** receives fixes — upgrade
  to the latest patch of the newest minor before requesting a backport.

This window is a commitment for the maintained line; it may be extended for a
given release at the maintainers' discretion, never silently shortened.

## Release cadence & gates

- There is no fixed calendar cadence; releases ship when a coherent set of
  changes is ready and green.
- Every release passes the CI gate in
  [`v1-release-criteria` §3](../../../.kiro/steering/v1-release-criteria.md) and,
  if it carries a migration, the upgrade-path test in §4.
- A **major** release re-runs the entire v1 release-criteria checklist.

## Relationship to the Definition of Done

When a new bug class is discovered after 1.0.0, the fix must also add a tripwire
(test or lint) and update the Definition of Done in the same PR, so the class
cannot silently regress. See `.kiro/steering/definition-of-done.md`.
