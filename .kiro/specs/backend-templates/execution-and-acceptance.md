# Backend Templates — Execution and acceptance

Planning revision 2. Epic #900; specification PR #911. No runtime implementation is included.

## Shared verification fixture

Use a fresh isolated test deployment with source site A, target site B and unrelated site C. Principal adminAB has schema/catalog permissions on A/B, editorB has ordinary item permissions only, outsiderC has C only. Use a non-superuser application DB role for RLS tests; never run destructive tests against shared user data.
Install an unrelated collection with a sentinel record in B before conflict/failure tests. Snapshot metadata, content counts and canonical content before mutation; exclude expected audit/plan metadata when asserting no target schema/content writes.
Use both schema-only and demo WordPress-alike fixtures. IDs must be generated at installation, not copied from fixtures. Test helpers may use logical record keys only.
Force time through an injected clock for expiry, use deterministic barriers for races (not sleeps), and inject faults at transaction boundaries. Verify post-commit events and cache through real adapters where required.

## Scope and implementation sequence

BT01 (#901) freezes contracts. BT02 (#902) implements catalog; BT03 (#903) plans; BT04 (#904) supplies transaction/install core and seed hook contract; BT05 (#905) implements that hook.
BT04 can land schema-only and an injected seed-failure test before BT05; it is not accepted as feature-complete until combined BT04/BT05 tests pass. This avoids a circular implementation dependency.
BT06 (#906), BT07 (#907), BT08 (#908) integrate after their declared dependencies; BT09 (#909) verifies the complete v1.
BT10 (#910) is a separately accepted future upgrade milestone. R10 v1 obligations (immutable revisions/provenance/no auto-update) still apply to BT02/BT04/BT09.
Owner lanes are roles, not assigned individuals or active delegated work. Implementation scheduling is left to the project owner.

## Artifact decisions and limits

v1 guarantees JSONB-backed logical collections in a supported transactional CMS database. Other storage modes require explicit compatibility evidence before advertised support; unsupported modes fail before mutation.
Initial limits: 2 MiB UTF-8 JSON document, nesting depth 32, 100 collections, 2000 fields, 500 relations, 1000 seed records across the artifact, 1 MiB canonical UTF-8 seed values/references across the artifact. Validation at limit succeeds only if all other constraints hold; limit+1 fails. Repeated/duplicate keys in raw JSON must be rejected by the authoring ingestion path rather than silently overwritten.
Canonicalization sorts object keys and keyed resource lists; preserves order in arrays whose order carries semantics. Hash uses canonical artifact bytes including seed packs; exclude only transport data that is outside the artifact.
Limits are initial product decisions; benchmark evidence may motivate a reviewed spec/issue update, never silent truncation.
The committed illustrative JSON is not yet the release fixture: BT07 replaces the compatibility placeholder and expands demo data to cover all 8 collections and declared relation kinds.

## Acceptance evidence template

For each BTxx-ACyy record:
- Implementation PR and exact head SHA.
- Test/fixture identifier; command and environment/runtime/DB versions.
- Expected behavior and actual output, counts or screenshots.
- Verdict: pass / fail / blocked / not run; reason and follow-up issue if not pass.
- Reviewer identity and date; rerun affected evidence after changes.

Spec consistency checks are not runtime tests. Do not mark ACs passed because markdown/JSON parses.
Release v1 only after BT01–BT09 criteria pass, required repository checks pass and applicable setup/RLS/shell/docs checks are reviewed. Future BT10 stays open independently.

## Mirror policy

Each work-items/BTxx.md contains the same implementation work breakdown, AC IDs, scenarios, evidence requirements and completion gate as GitHub #901–#910. tasks.md is an index, not a second abbreviated definition.
When review changes an AC, update both copies and preserve its identifier. Add a new ID for a new criterion; do not renumber existing evidence. Requirements -> work item -> test evidence is the traceability chain.
