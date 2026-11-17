# Backend Templates — Design

Status: proposed. Epic #900. Requirements: [requirements.md](requirements.md).

## Existing code and integration
- packages/contracts/src/schemas/config-manifest.ts is the actual current contract (older code-first specs mention packages/shared).
- apps/cms/src/services/config-export-service.ts and config-serialize.ts provide stable-key export.
- config-import-service.ts delegates to SchemaService; merge can update existing resources and therefore is NOT sufficient for create-only installation.
- The import service currently falls back to non-transaction execution when db.transaction is unavailable. Template installation MUST require transaction capability and transaction-bound application; do not inherit that fallback.
- apps/cms/src/services/schema-service.ts handles model/storage compatibility.
- Existing ItemService, MCP service/route, packages/ai-skills and AISecureHarness retain permission and approval enforcement.

## Chosen architecture
JSON artifact -> strict contract/integrity validator -> catalog revision -> target planner -> governed approval -> transaction-bound installer -> existing schema/item services.
REST, MCP and Studio share this pipeline. No raw SQL interpreter, second schema engine, AI-generated runtime code or deployment scaffolder.

## Artifact contract
Required: formatVersion, slug, displayName, templateVersion, compatibility, config.
Optional: description, seedPacks. config is the existing manifest with collections/fields/relations and empty settings/webhooks in v1. managedScopes is omitted; replacement modes are unavailable. System collections and non-nanoid domain keys are rejected for portable v1.
compatibility declares supported storage modes and a CMS version range fixed when the feature ships (do not invent a release version now). Example artifact uses a planning placeholder for that range and is not a production fixture.
seedPacks maps stable pack names to records: { key, collection, values, references }. references maps relation field names to logical record keys; persisted IDs are generated server-side. Reject duplicate keys, external references and non-scalar fields with unexpected reference shapes. Derived digest covers canonical complete artifact including seed packs, not an embedded self-referential digest.
Initial server limits: 2 MiB JSON, depth 32, 100 collections, 2000 fields, 500 relations, 1000 total seed records and 1 MiB seed values per request. These are proposed defaults to benchmark in BT09; reject rather than silently truncate.

## Catalog and persistence
Proposed site-scoped tables: backend_templates (slug, draft, owner), backend_template_revisions (immutable version, digest, manifest), backend_template_installations (template identity/digest, baseline manifest, namespace map, seed pack, status, target site, resource ownership, idempotency key). Domain IDs use nanoid; audit records use uuidv7. All tenant rows carry site_id and repository RLS pair; uniqueness includes site_id. Read-only official artifacts live in the application bundle, not shared mutable tenant rows.
A source private template requires source-site read permission even if the principal can administer target B. Initial cross-site sharing requires the same authorized principal exporting/importing; no implicit organization-wide visibility. Snapshot revision into the plan so source edits cannot change an approved install.
Persist plans with target-scoped IDs and bounded expiry (15 minutes proposed); plan IDs are not bearer authorization. Idempotency uniqueness is targetSiteId + key, payload digest must match. Install audit/record references pin original template origin without exposing inaccessible source content.

## Planning and install state machine
Plan: resolve accessible revision -> validate -> authorize explicit site -> normalize namespace -> validate all storage adapters -> inspect conflicts -> capture target fingerprint -> report plan.
States: planned -> awaiting_approval (agent) -> applying -> completed; invalidated/expired/denied/failed are terminal for that plan. Plans do not mutate content/schema. No apply request may replace server-recorded plan payload.
Apply: reauthorize caller and approval -> acquire per-site installation lock -> compare fingerprint and revision digest -> transaction -> allocate IDs -> collections -> fields -> relation definitions -> seed inserts/reference binding -> installation provenance -> commit.
Required cycles must be rejected preflight if current ItemService/storage constraints cannot satisfy them in one transaction; never temporarily weaken validation globally. Enforce same transaction through schema/item helpers; nested transaction behavior requires DB-backed verification.
Schema-only skips all item writes. Seed writes use caller-aware ItemService, including target collection permissions, validation and normal ID generation. Side effects (flows, webhooks, external indexing) are deferred until commit via supported outbox/runtime facilities; no partial external effects on rollback.
Cache invalidation occurs after commit; existing per-call invalidation must be adapted or buffered for this path. Completed retries return existing installation; mismatch key returns conflict. An interrupted worker consults durable state/transaction outcome before retry. Transaction locks serialize conflicting installs; recheck target inside the lock to close preview/apply race.

## API and MCP proposal
REST under /api/v1/backend-templates: list/get, draft create/update, validate, capture, publish, plan, instantiate; installation status by ID. Exact routes finalized with BT01. Standard {data, meta?}/{errors} envelopes. Site header and explicit targetSiteId must agree; never trust manifest site IDs.
MCP proposed names: template_list, template_get, template_validate, template_create, template_capture, template_publish, template_plan, template_instantiate, installation_get. Each has exact shared JSON Schema; schema:write actions use existing governed harness. Authoring requires catalog write; capture requires source schema read and per-item read if seeds are requested; publication does not grant catalog visibility. Apply requires target schema write plus item capabilities when seeding. Schema capabilities remain dangerous even if the tool is named “instantiate”.
Agent example: resolve “wordpress alike” -> choose accessible exact wordpress-alike@1.0.0 -> template_plan(targetSiteId=B, seedMode=none) -> explain inventory -> template_instantiate(planId, idempotencyKey) -> pending approval -> approved recorded action resumes -> installation_get returns collection links. Missing target is a structured missing-input error; the agent asks the user rather than guessing.
Validation errors include JSON paths; stable categories: INVALID_TEMPLATE, UNSUPPORTED_FORMAT, INCOMPATIBLE_RUNTIME, LIMIT_EXCEEDED, AMBIGUOUS_TEMPLATE, SITE_MISMATCH, NAME_CONFLICT, STALE_PLAN, APPROVAL_REQUIRED, IDEMPOTENCY_CONFLICT. Authorization failures follow existing transport policy without leaking hidden resources.

## WordPress alike and storage
wordpress-alike contains content author profiles, posts/pages, categories/tags, explicit taxonomy join collections and comments. No auth users or uploaded file binaries are copied. References and data are independent after install. Default JSONB realizes logical tables through existing CMS storage; supported physical modes must prove DDL transaction behavior and tenant safety before advertised compatibility. “Clone BE” is model+optional data in the existing CMS site, not cloning infrastructure or WordPress plugins.

## Version roadmap
Phase 1 (BT01–BT09): JSON contract, private/bundled catalog, MCP authoring, explicit-site create-only install, optional bounded inline seeds, Studio, documentation.
Phase 2 (BT10): ownership-aware three-way upgrades and explicit migrations; no auto-updates. Reuse content-environment/GitOps components if their contracts fit, without making these epics mandatory.
Later candidates: signed shared catalog, assets and resumable large seed packs, dependency packs and site provisioning. Unsupported components fail until versioned support exists.

## Setup and security review
Implementation will need idempotent schema migrations and RLS for catalog/plan/install records; existing sites receive no automatic template installation or content seeding. Existing admin capability model is reused, exact catalog capability grants documented in BT02/BT06. No required deployment secret or mandatory setup wizard step. Optional post-setup template chooser lives in Studio. BT09 must add the setup registry row, evaluate backfill and release flags, shell API-base/token compatibility and EN/VI docs. This spec-only PR makes no setup/runtime changes.
Untrusted template descriptions never become instructions. No scripts, arbitrary URLs or credentials. Sensitive source data is not captured implicitly. Runtime cache/locks/queues use site-prefixed keys.
Tests cover semantic validation, canonical round-trip, real DB atomicity/concurrency/RLS, permission revocation, approval replay, MCP schemas and recorded conversations, Studio site switches and later item population. Full repository DoD remains pending implementation; no new failure class requiring a DoD edit is claimed in this planning change.
