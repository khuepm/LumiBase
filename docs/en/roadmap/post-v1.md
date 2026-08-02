# Post-v1 roadmap

Status: planning. Nothing on this page is scheduled to start before v1.0.0 ships. The release exit checklist for v1 is tracked separately in issue #212.

This page is the narrative companion to the "LumiBase Post-v1 Roadmap" project board. The board holds the issues and their state; this page holds the reasoning behind the ordering, and the corrections that came out of reviewing the four candidate themes against the code rather than against the docs.

## Where the four themes actually stand

| Theme | Differentiation | Maturity today | Remaining effort | Order | Epic |
| --- | --- | --- | --- | --- | --- |
| GitOps two-way sync | 7.5 | 6 | High | 1 | #362 |
| MCP interop | 9.5 | 8.5 | Medium | 2 | #361 |
| Change Feed and realtime | 8 | 7 | Medium | 3 | #363 |
| Authorization completeness | 6 | 8.5 | Low | 4 | #364 |

Differentiation is measured against Directus, Strapi, Sanity and Contentful. Maturity is what is observable in the codebase at v0.25.0.

## Theme 1 — MCP interop

This is the strongest asset in the project and the only one of the four where the code exceeds the marketing. Two MCP surfaces exist, both running through a single harness codepath: a Streamable HTTP JSON-RPC endpoint at POST /api/v1/mcp, and a stdio server shipped as the mcp-server package. The parity invariant, that a tools/call decision matches a direct harness decision, is pinned by a property test. Around it sits real governance: autonomy levels L0 to L4, a trust ledger where promotion is human-gated and demotion is automatic, a versioned constitution with hash pinning, a four-scope kill switch, and a load guard.

What is missing is spec surface, not depth. Only the tools primitive is implemented; there is no server-initiated stream, so a tool registry change is invisible until the client reconnects; and authorization is a plain bearer token rather than OAuth 2.1 with protected resource metadata. That last gap is the single reason LumiBase cannot be offered as a hosted connector in the clients that matter, and it is the highest-value item in the theme.

Issues: #344, #345, #346, #347.

## Theme 2 — GitOps two-way sync

Phases A to E are genuinely done: six git tables with row-level security, a provider abstraction covering GitHub and GitLab, encrypted tokens, verified webhooks with an idempotent event log, a pull-request and CI dashboard with ingested logs, reverse status checks, and a commit-to-item provenance map.

The loop, however, is one-way and intent-only. syncFromRepo reads lumibase/intents.json into content intents and reconciles; schema apply is deferred; nothing writes back from the CMS to the repository; nothing triggers on merge to main; the git-sync agent has a seeded role but no execution loop; and preview environments are opt-in, off by default, and noted as needing staging verification.

So the current honest description is "config export plus intent import", not bidirectional GitOps. Closing that gap is the largest claim-to-reality delta in the product and the clearest developer pain, which is why this theme goes first even though its raw differentiation score is lower than MCP.

Issues: #348, #349, #350, #351, #352.

## Theme 3 — Change Feed and realtime

The Change Feed contract is well designed and should not change: a transactional outbox, total order per site on the composite keyset of occurred_at and id with a two-second safety lag, at-least-once delivery with the event id as the idempotency key, forward-only acknowledgement, replay inside a retention window, HMAC-signed webhook batches with backoff and dead-lettering, sandboxed extension subscribers, row-level security on all three tables, and a documented OpenAPI and SDK surface. Long-polling and schema-level DDL capture are real.

Two corrections are needed. First, the Change Feed is not a WebSocket product. The realtime plane is a separate subsystem that publishes directly from the item service and carries no feed envelopes, cursors or replay, so describing the feed as realtime WebSocket subscriptions overstates it. Second, and more seriously, the realtime plane checks read permission only when a client subscribes. There is no per-subscriber field masking and no row-rule re-evaluation on fan-out, which means a masked field can reach a subscriber who would not see it over REST. For a product whose permission system is a headline claim, that is the weakest link, and it should be treated as correctness debt rather than as a feature.

A third gap affects self-hosting: the Docker fan-out hub is in-process, so any deployment with more than one replica silently drops events.

Issues: #353, #354, #355.

## Theme 4 — Authorization completeness

Release v0.25.0 shipped the third realm from ADR-011 and the work is solid. An unauthenticated request resolves to the site's opt-in public role instead of a blanket 401, so row filters and field masks stay in force; admin and app access are pinned off on the public role by check constraint; reads are restricted to GET and HEAD on allow-listed content prefixes; and three layers of cache-penetration defence sit in front of Postgres.

Two calibrations matter for how this is positioned. The realm separation is enforced by role, token audience, check constraints and app-layer policy compilation, not by database-level row security per realm; row-level security covers tenant isolation. And field-level permissions are not new here and are not universally an enterprise-only feature: the argument holds against Contentful and Sanity, but Directus ships field-level permissions in open source.

What remains is small: GraphQL is excluded from the public realm because operations arrive over POST, which leaves out the delivery path a frontend would most naturally use; the parentId column on roles implies an inheritance that the evaluator never applies; and the role-flag to policy-flag migration is still half-done, which forces every new surface to screen two sources for privilege escalation.

Issues: #356, #357, #358.

## Sequencing

Wave 1 makes the GitOps claim true. Wave 2 makes the MCP server installable rather than merely deep. Wave 3 pays the realtime correctness debt. Running alongside all three, issue #359 tracks the reference application and public benchmark.

That last one deserves emphasis. Feature breadth is no longer the constraint. The repository is a few months old and already covers a surface comparable to a mature CMS, but there is no public deployment, no published latency numbers, and no recorded walkthrough of an agent operating content end to end under the trust ledger. Every headline claim currently has to be taken on trust from the documentation. Producing that evidence is cheaper than any of the feature work here and is likely worth more.

## Ground rules for this roadmap

Each issue was written against the code and cites the files that justify its premise, so a stale issue can be identified and closed with a link to the commit that made it stale, rather than quietly edited. If a theme's scoring changes, update the table on this page in the same pull request.

## References

Project board: LumiBase Post-v1 Roadmap. Milestone: Post-v1. Label: post-v1.

Related documents: docs/en/mcp/index.md, docs/en/roadmap/git-integration.md, docs/en/features/cdc-change-feed.md, docs/en/architecture/realtime-websocket-implementation.md, docs/en/features/permissions-rbac.md, docs/en/architecture/decisions/adr-011-user-management-realms.md.
