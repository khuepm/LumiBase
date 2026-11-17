# Backend Templates — Requirements

Status: proposed / not implemented. Epic: #900. Spec baseline: main 010c1944c5568416a04e376039e70fcca573ecae.
User outcome: an agent receives “build a WordPress-alike backend on site B, without sample data”, selects the named template and provisions the complete declared model into B.

## R1 — Portable complete model
One JSON document MUST describe all required collections, fields, validation/defaults, supported presentation metadata, storage choices and relations (including explicit junction collections). “Model” means LumiBase collection schema; “table” follows its storage adapter. JSONB is the portable default; do not promise one physical SQL table per collection. Unsupported physical/materialized/external requirements MUST fail preflight, not downgrade silently. Template v1 excludes arbitrary SQL/code, external database bindings, auth accounts, credentials, executable plugins, flows and webhooks. Completeness means every declared supported component, not a full WordPress runtime.

## R2 — Versions and compatibility
Envelope formatVersion=lumibase.template@v1 embeds config.version=lumibase.config@v1. templateVersion is independent SemVer. Published revisions are immutable and content-addressed. Validate the entire object before catalog publication or target mutation, including reference integrity, field types/options and runtime requirements. Unknown required components/versions fail explicitly. Canonical export strips runtime IDs, site IDs and secret-bearing settings.

## R3 — Create and reuse through MCP
Authorized agents MUST create a draft from JSON, validate it, publish an immutable revision, list/get it and capture a selected existing site's model as a new draft. Capture is schema-only unless the caller explicitly chooses permitted sample records. Creation never implicitly installs. Private catalogs are source-site scoped; bundled official templates are read-only deployment assets. No cross-site discovery without source permission. Same display name MUST NOT silently resolve to the wrong catalog.

## R4 — Explicit site and preview
Every install MUST specify targetSiteId; it must match the authenticated request's site context. Source catalog site and target site are distinct authorization checks. A selected existing site is required in v1; provisioning new sites/servers is separate. Plan pins template identity, version, digest, target site, namespace mapping, seed choice and current schema fingerprint. Preview reports all components, counts, storage prerequisites and conflicts without changing schema/content. Site changes invalidate the plan.

## R5 — Non-destructive independent clone
v1 creates only new names; unrelated collections may remain. Any collision fails, except a verified retry of the same completed installation. Fresh IDs replace source identities; local references remap consistently. Namespacing must rewrite collection/field/relation/seed references, not arbitrary strings. Do not copy users, secrets, permissions or production data by default; do not grant public access. Ready means accessible under existing target authorization.

## R6 — Atomic and governed installation
Schema, relation setup, selected seed rows and completed installation provenance commit atomically on a transactional supported runtime. Unsupported transactional capability fails before mutation. Retry/concurrency MUST NOT produce duplicates. Stale plan, expired/revoked approval or changed permissions requires replan/reapproval. Schema writes by agents remain schema:write dangerous actions via AISecureHarness/HITL. Approval binds exact payload and is consumed once. Logs must not expose seed payloads. Failed transactions leave no partial backend; failure audit is separate.

## R7 — Optional data
seedMode defaults to none even when packs exist. Omitted packs are valid. Schema-only install creates zero content items, including junctions; metadata defaults do not count as seed records. Caller may opt into a named bounded inline demo pack. Allocate record IDs, resolve logical references and validate required/cyclic relations. Invalid references fail atomically. Later item API/MCP operations populate the chosen site using normal permissions; templates do not need reseeding. Files/external downloads and large background seeding are future work.

## R8 — Shared API/MCP/Studio behavior
All transports call the same authoring/planning/install services. MCP tool schemas and error behavior match shared contracts. Tools expose discover/create/capture/publish/plan/instantiate/status; dangerous mutations retain approval requirements. Studio exposes import/export, template revision, target site, relation preview, seed toggle (off), conflict remediation and result links. No AI interpretation is required after a valid template has been resolved.

## R9 — WordPress-alike acceptance
Official wordpress-alike 1.0.0 models authors, posts, pages, categories, tags, post_categories, post_tags and comments. authors are content profiles, not login identities. Relationships cover post author, comment post/author, comment parent, page parent and taxonomy junctions. Lightweight and demo use identical schema. Successful installation permits ordinary authenticated content CRUD and relation traversal. No PHP, WordPress REST compatibility, plugin execution or hosting parity is implied.

## R10 — Evolution
v1 includes immutable revisions and installation provenance sufficient for future upgrades. Publishing a new revision never changes installed backends. A later explicit upgrade compares installed baseline, live target and desired revision; user drift produces conflicts and destructive changes require reviewed migration/approval. Seed upgrades remain separate opt-in operations. No destructive rollback claim without content-aware migrations.

## Acceptance matrix
| Scenario | Expected |
|---|---|
| Agent creates JSON template and installs into selected B | Correct revision; governed approval; complete model |
| No seed argument | All collections, zero content rows |
| Demo seed chosen | Fresh IDs, correct joins, no source identities |
| Later API/MCP item create | Works under B's normal permissions |
| Wrong site / revoked access / stale approval | No target writes |
| Invalid relation / unsupported storage / oversized pack | Structured preflight error |
| Failure midway / duplicate request / concurrent install | Atomic rollback or exactly one completed installation |
| New revision published | Existing installation unchanged |

All implementation acceptance boxes remain pending; this planning change does not ship the feature.
