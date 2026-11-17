# Backend Templates — Implementation plan

Status: all implementation pending. Epic: [#900](https://github.com/khuepm/LumiBase/issues/900).

## BT01 — Versioned JSON template contract and validation

- [ ] [#901](https://github.com/khuepm/LumiBase/issues/901) — Contracts
- Requirements: R1, R2. Depends on: none.
- Scope: Define lumibase.template@v1 envelope embedding lumibase.config@v1; immutable templateVersion, slug, compatibility and optional named seed packs. Validate unknown versions, duplicate keys, dangling relations, unsupported field/storage features, size/depth/count limits and reserved/system resources. Canonical digest excludes transport metadata; source and target site IDs never enter portable artifacts. JSON Schema and Zod must agree.
- Acceptance: Valid schema-only JSON is accepted; unknown/unsupported components fail with paths before writes; canonical reordering retains digest; seeds omitted is valid.

## BT02 — Site-scoped template catalog, revisions and MCP authoring service

- [ ] [#902](https://github.com/khuepm/LumiBase/issues/902) — Backend/catalog
- Requirements: R2, R3. Depends on: BT01.
- Scope: Add private site-scoped templates and immutable revisions; bundled official templates are read-only global code assets, never shared tenant rows. Support create from JSON, edit draft, publish revision, list/get/export and capture selected schema from a source site. Capture defaults to schema-only; optional seed capture requires item read permission and redaction. No public marketplace in v1.
- Acceptance: Two sites cannot enumerate each other's private templates; published revision cannot mutate; source export/import round-trip preserves schema; author can create a reusable template without applying it.

## BT03 — Deterministic install planner with explicit target site and conflict checks

- [ ] [#903](https://github.com/khuepm/LumiBase/issues/903) — Backend/planner
- Requirements: R4, R5. Depends on: BT01, BT02.
- Scope: Resolve exact slug+version+digest and explicit targetSiteId. Authorize source access and target independently. Build schema/relations/seed plan, resource counts, diff, fingerprint, expiry and prerequisite errors. v1 create-only: unrelated collections allowed, collisions rejected unless owned by the identical completed installation. Namespace mapping rewrites every reference. Never silently merge or replace existing data.
- Acceptance: Dry-run writes no target content/schema; missing or mismatched site is rejected; same names in two catalogs are not guessed; stale target fingerprint invalidates plan; unsupported storage runtime fails preflight.

## BT04 — Atomic backend instantiation and installation provenance

- [ ] [#904](https://github.com/khuepm/LumiBase/issues/904) — Backend/apply
- Requirements: R5, R6. Depends on: BT03.
- Scope: Reuse ConfigImportService/SchemaService through transaction-bound services; add create-only enforcement rather than blindly calling merge. Install schema, relation definitions, optional seeds and provenance in one supported DB transaction. Require transactional capability, no non-transaction fallback. Lock target scope, recheck permissions/fingerprint, persist idempotency key bound to plan digest, emit audit/cache/outbox effects after commit.
- Acceptance: Injected failures at collection, relation and seed phases roll back all target changes; concurrent/retried identical request returns one installation; key with different payload conflicts; existing data untouched; post-commit invalidation and recovery are verified.

## BT05 — Optional seed packs with local references and permission-aware writes

- [ ] [#905](https://github.com/khuepm/LumiBase/issues/905) — Backend/data
- Requirements: R7. Depends on: BT01, BT04.
- Scope: Default seedMode=none. Implement selected inline seed pack only, bounded for atomic v1. Allocate fresh domain IDs for logical record keys, resolve relation references in two passes and validate cycles/required constraints before writes. Use ItemService with caller context and transaction; suppress external side effects until commit. No passwords, users, credentials, binary files or arbitrary URL fetch. Later API/MCP item creation remains ordinary content operations.
- Acceptance: Schema-only install creates zero content rows and all declared collections; sample seed IDs differ between sites; invalid refs and unauthorized writes roll back; retry never duplicates records; data can be added later through existing API/MCP.

## BT06 — Governed MCP template create, discover, plan and instantiate tools

- [ ] [#906](https://github.com/khuepm/LumiBase/issues/906) — MCP/AI
- Requirements: R3, R4, R6, R8. Depends on: BT02, BT03, BT04, BT05.
- Scope: Register template_list/get/validate/create/capture/publish/plan/instantiate plus installation_get using existing MCP registry and AISecureHarness. Tool names are proposed; align naming conventions on implementation. Exact shared schemas, capability filtering and runtime permission recheck. Schema writes require HITL bound to target site, template digest, plan fingerprint and seed choice; approval resumes the recorded action once. Metadata is untrusted text, never instructions.
- Acceptance: Recorded tools/list + tools/call scenario: agent creates template then requests wordpress-alike on site B without seed, plan -> pending approval -> authorized resume -> ready backend. Denial/expiry/revoked access/stale plan cause zero writes; MCP and REST result/error contracts match.

## BT07 — WordPress-alike reference template with lightweight and demo variants

- [ ] [#907](https://github.com/khuepm/LumiBase/issues/907) — Template/content modeling
- Requirements: R1, R7, R9. Depends on: BT01, BT05.
- Scope: Ship wordpress-alike 1.0.0: authors (content profiles, not auth accounts), posts, pages, categories, tags, post_categories, post_tags and comments; explicit relation fields/junctions, defaults/validation and supported display metadata. One canonical schema, no seed by default, optional demo seed pack. Publish precise component inventory and no WordPress/PHP/plugin/API compatibility claim.
- Acceptance: Single JSON artifact constructs every inventory component; joins and author/comment relationships resolve; lightweight variant has zero rows; demo creates coherent synthetic records; no source IDs or secrets; API/MCP CRUD works.

## BT08 — Studio template library, site selection and installation review

- [ ] [#908](https://github.com/khuepm/LumiBase/issues/908) — Studio
- Requirements: R4, R8, R9. Depends on: BT02, BT03, BT04, BT05.
- Scope: Provide catalog/import JSON/export/capture surfaces, revision selector, explicit site selector, schema/relations preview, seed toggle default off, conflict/error views and result links. Use shared plan/apply service, show approval state for governed operations. Keep selected site fixed through planning and confirmation; changing site invalidates plan.
- Acceptance: User picks WordPress alike and site, reviews exact version/components/seed counts and opens resulting collections; loading/error/retry/empty states work; authorization and shell API-base/token contracts preserved; no automatic site creation or public grants.

## BT09 — Integration acceptance, rollout documentation and setup impact

- [ ] [#909](https://github.com/khuepm/LumiBase/issues/909) — QA/docs
- Requirements: R1–R10. Depends on: BT06, BT07, BT08.
- Scope: Add real DB integration, MCP recorded-request, tenant/RLS, concurrency and browser acceptance coverage. EN/VI API/MCP/tutorial docs distinguish schema template from deployment scaffold and physical storage. Complete setup-impact registry, idempotent migration/backfill and release flag review; all feature checks remain pending until implementation.
- Acceptance: Prove full agent and Studio flows on supported runtime; unsupported runtime explicitly rejected. Verify two-site isolation, atomic failures, repeat install, empty data, later API/MCP population, stale approval, template version compatibility. Record actual commands/results; no skipped DB tests counted as pass.

## BT10 — Follow-up: installed template upgrades with three-way schema diff

- [ ] [#910](https://github.com/khuepm/LumiBase/issues/910) — Backend/versioning — future
- Requirements: R10. Depends on: BT09.
- Scope: Future phase, not v1 blocker: plan base-installed vs current-site vs target-template revision; track ownership and user drift; explicit migration plan and approval for destructive changes; never auto-upgrade on catalog update. Keep seed upgrades separate and opt-in, preserve user content.
- Acceptance: Catalog 1.1 publication leaves existing 1.0 installation unchanged; additive upgrade preserves content; user drift produces conflict; destructive migration requires reviewed plan; failed upgrade retains previous installation provenance.

## Delivery order and boundaries

BT01 -> BT02 -> BT03 -> BT04 -> BT05 -> BT06/BT07/BT08 -> BT09. Independent contract work can overlap after BT01 freezes; dependencies in each ticket are authoritative. BT10 is future work, not a v1 release blocker.

Owner lanes are suggested specialisms, not assigned people or running agents. No implementation was delegated. Each ticket needs its own linked PR and test evidence. Shared schema changes are coordinated through BT01. Do not mark any box complete on the basis of this specification.

## Spec-only verification

Review all R1–R10 against tickets, validate illustrative JSON syntax and reference integrity, verify local Markdown links and Git diff whitespace. No runtime implementation or application tests are claimed. The example's compatibility placeholder must be replaced and validated against the implemented contract before it becomes a bundled fixture.
