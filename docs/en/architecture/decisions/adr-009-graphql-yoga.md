---
version: 1
lastUpdated: 2026-07-05T10:56:37.270Z
sourceLang: en
contentHash: d5c1914b1d9af5eb
---

# ADR-009: GraphQL Yoga with Dynamic Schema over ItemService

**Date:** 2026-06-17
**Status:** Accepted

## Context

LumiBase has shipped a complete REST API on Hono, and its vision positions
Delivery consumers as accessing content via "REST/GraphQL/WS". The consumer
SDK roadmap (`docs/en/roadmap/consumer-sdk.md`) reserves a composable
`.with(graphql())` adapter. Until now GraphQL was unimplemented on both the
API and Studio.

We want a GraphQL surface for **content items** (query + mutation) that:

1. Runs **edge-native** on Cloudflare Workers as well as Node/Docker.
2. Reuses — never bypasses — the existing governance baked into `ItemService`:
   multi-tenancy (`site_id`), permission row/field masks, RLS, soft-deletes,
   revisions/provenance, HITL pins, realtime broadcast, and search indexing.
3. Reflects LumiBase's **dynamic, JSONB-backed schema**: collections and
   fields are declared at runtime, not table-per-type, and differ per tenant.

Options considered:

- **GraphQL Yoga + graphql-js** — lightweight, Workers-compatible, integrates
  with Hono through a single fetch handler, and supports a per-request schema
  factory (needed for per-tenant dynamic schemas).
- **Pothos (code-first)** — excellent for *static* schemas, but LumiBase's
  schema is built at runtime from `collections/fields`, so Pothos's
  compile-time type building is a poor fit.
- **Apollo Server** — heavier, less optimised for the Workers edge runtime.

## Decision

Adopt **GraphQL Yoga + graphql-js**, mounted inside the authenticated
`/api/v1` Hono sub-app at `/api/v1/graphql`.

- **Inherited security:** because the route lives under the same
  `withTenant → withDb → withAuth → … → withRls` chain as REST, GraphQL gets
  tenant resolution, auth, and RLS for free.
- **Thin resolvers:** every resolver delegates to `ItemService`
  (`apps/cms/src/services/item-service.ts`). No resolver touches the database
  directly, so all governance is inherited (Non-negotiable rules #2, #4, #5).
- **Dynamic schema:** `buildSiteSchema()` reads the per-site
  `collections/fields` manifest via `SchemaService` and programmatically
  builds a `GraphQLSchema` (object type per collection; `Query.<collection>`,
  `Query.<collection>_by_id`; `Mutation.create_/update_/delete_<collection>`).
  Filter args map 1:1 onto `ItemService`'s existing `ItemFilter` operators.
- **Per-site schema cache:** `GraphQLSchema` objects are non-serialisable, so
  they are cached in-process keyed by `siteId` with a short TTL (60s);
  `invalidateSiteSchema(siteId)` drops one immediately.
- **Errors:** thrown `ItemServiceError`s are mapped to `GraphQLError` with
  `extensions.code` matching the REST error vocabulary, so clients handle
  errors identically across surfaces.
- **SDK:** a composable `graphql()` plugin (`packages/sdk/src/graphql`) adds
  `.query()` / `.mutate()` on top of the existing `rawRequest`, reusing its
  auth/tenant headers and 401 handling.

## Consequences

**Positive**
- One source of truth for content governance (ItemService); GraphQL cannot
  drift from or bypass REST's permission/tenancy rules.
- Edge-compatible, minimal dependency surface (`graphql`, `graphql-yoga`).
- Schema automatically tracks tenant collection/field changes.

**Negative / trade-offs**
- Per-request schema resolution costs a few manifest reads; mitigated by the
  in-process TTL cache.
- Field-typed introspection is best-effort: structured/relational fields fall
  back to a `JSON` scalar rather than fully nested GraphQL types.

## Follow-ups delivered

- **Hardening:** query depth limit + introspection disabled in production.
- **Nested relations:** m2o/o2m surfaced as nested fields resolved lazily via
  `ItemService` (m2m/m2a still on the JSON escape hatch).
- **Subscriptions:** `Subscription.<collection>_events` over SSE, bridged from
  the SiteRoom Durable Object realtime channel.

## Future work

- m2m/m2a nested relation types.
- Field-level permission masking of subscription payloads.
- Persisted queries and query cost limiting.
- Extend the surface beyond items (collections/users/admin) if required.
