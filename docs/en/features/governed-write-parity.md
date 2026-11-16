---
version: 3
lastUpdated: 2026-10-10T03:37:18.452Z
sourceLang: en
contentHash: 1cb0acffafbc3ac2
codeVerified: 2026-10-10T03:37:18.452Z
codeVerifiedHash: 1cb0acffafbc3ac2
codeVerifiedClaims: 8
---

# Governed write parity

AI skills use the same write checks as REST for flows, generic extension
registration and change-feed subscriptions. Capability and human approval gates
remain in the harness; approval does not replace input validation or service
permissions.

The stdio MCP tools `create_flow`, `install_extension`, `update_extension` and
`create_cdc_subscription` now route through the governed harness in `on` mode and in `auto` when the
governed endpoint is available. Existing `auto` fallback behavior remains. CDC translation preserves `payload_mode`; the canonical contract
and transport fixture are checked together to prevent dropped arguments.

## Flows

`apps/cms/src/services/flow-management.ts` is shared by the flow route and the
`createFlow` skill. Active flows require a valid operation graph. Schedule
triggers validate cron, require cron when active, and compute `nextRunAt` on
creation. Drafts may retain incomplete graphs. The REST PATCH path uses the
same graph and cron validators on the effective saved state.

## Extensions

`apps/cms/src/services/extensions-service.ts` handles both REST and skill writes.
It requires a tenant-bound permission context, probes install/enable/configure/
grant_capability/delete permissions as appropriate, applies signature policy,
and reserves `lumibase-*` for official signatures. Official status and verification
time come from the verifier, never client input. Enabling an unverified official
extension is rejected.

Updates evict the sandbox module on bundle/version changes and synchronize hook
subscriptions with the change feed. Subscription synchronization remains best
effort, as on the existing REST path. Generic registration still does not resolve
a marketplace slug or download marketplace provenance; these contracts are distinct.

Approved extension actions rebind the service to the original requester's current
permission context. Missing principal context fails closed, including an agent-role
requester with no principal-bound policies. The reviewer's permissions cannot
substitute for the requester's.

## Change feed

The `createCdcSubscription` skill accepts `payload_mode` (`reference` or `snapshot`)
and forwards it to `SubscriptionService`. Harness construction forwards the runtime
cache, and the service receives an audit sink. Creating a subscription invalidates
the cached feed-enabled flag and records `cdc_subscription_created`.

## Multi-tenancy and verification

Signing policy and publisher keys are deployment-level trust configuration.
Extension rows, flows, subscriptions, audit events and cache keys remain scoped
to the site. No migration, wizard step or new secret is required.

`apps/cms/src/services/__tests__/p2-recovery-parity.db.integration.test.ts` exercises
both transports on disposable PostgreSQL: denied writes, active schedules, extension
permissions/signatures, CDC cache invalidation, audit and two-site isolation. Run it
with `DATABASE_URL` pointing to a disposable database, never a shared development DB.
