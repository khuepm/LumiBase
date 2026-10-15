---
version: 5
lastUpdated: 2026-10-15T18:05:44.510Z
sourceLang: en
contentHash: d22f26a398f28890
codeVerified: 2026-10-15T18:05:44.510Z
codeVerifiedHash: d22f26a398f28890
codeVerifiedClaims: 14
---

# Jev semantic drift for Content Intents

A Content Intent's deterministic rules (`required_fields`, `freshness`, `translations`, `link_health`, `field_constraint`, `glossary_compliance`) are checked by code. A `semantic` rule adds a judgement those rules cannot make, such as "this article strays from its brief" or "this copy is off-brand". The judgement comes from one `noul` question of a pinned [review profile](./draft-review.md) version, asked through the same governed decision path as `POST /api/v1/ai/reviews`.

The feature only detects and suggests a review. It never edits content or publishes.

> **Status.** The semantic pass is off by default (`aiDecisions.drift: false`). The VI/EN drift fixtures exist and are scored by the [Jev benchmark](./jev-benchmark.md) (`--task drift`), but no live provider run has been made. There are no measured precision or false-positive numbers yet.

## The rule

```json
{
  "type": "semantic",
  "key": "off-brief",
  "version": 1,
  "profileKey": "brief",
  "profileVersion": 3,
  "questionKey": "off_brief",
  "threshold": 0.8,
  "fields": ["title", "body"],
  "contextSource": "field:brief"
}
```

- `key` identifies the rule across versions and must be unique among the intent's semantic rules. Bump `version` whenever the rule's meaning changes. An intent update that changes `profileKey`, `questionKey`, `contextSource` or `fields` of a stored rule without bumping its `version` is refused with `422 SEMANTIC_RULE_VERSION_REQUIRED` (`assertSemanticVersionBumps`), because the fingerprint would stay the same and the old answer would stand for the new rule. `profileVersion` and `threshold` may change without a bump: the profile version is in the fingerprint, and the threshold is applied to the stored answer on every pass.
- `profileKey` + `profileVersion` pin one review profile version, and `questionKey` names a `noul` question in it. The question asks whether the item drifts. A question of another type makes every evaluation `unevaluated` (`question_not_noul`).
- `threshold` (0.5–1): `noul ≥ threshold` is drift, `1 − noul ≥ threshold` is clean, anything in between is `unevaluated` (`between_thresholds`). With a threshold of 0.5, an answer of exactly 0.5 meets both sides and is `unevaluated` too.
- `fields` are the fields judged (default: the profile's fields). Only fields that are also profile fields are read.
- `contextSource`: `intent` means the profile's criteria are the whole reference. `field:<name>` also sends that item field (a brief, an outline) as the reference. The field must be a profile field, and an empty one makes the evaluation `unevaluated` (`context_missing`).

The schema is `ruleSchema` in `apps/cms/src/services/intent-service.ts`. The outcome mapping and fingerprint helpers are in `apps/cms/src/services/semantic-drift.ts`.

## Turning it on

A site admin sets both flags in the `aiDecisions` setting:

```json
{ "enabled": true, "drift": true }
```

`enabled` is the site's opt-in to sending content to the provider, and turning it off is the kill switch. `drift` turns on only the semantic pass. While either flag is off, the scan reports `semantic.status: "off"`, sends nothing, and leaves every semantic drift row exactly as it was. Every provider call re-reads both flags, and the pass checks `drift` again before each item, so switching `drift` off stops a running pass at the next item and keeps the cursor. A site admin switches `drift` in Studio under **Settings → AI decisions** (**Evaluate semantic drift rules**), or through the settings API. The other keys of `aiDecisions` (for example the draft-review pilot written by Studio) are kept.

## How a scan runs

`POST /api/v1/intents/:id/scan` and the Flows `drift-scan` operation run the deterministic rules first, then the semantic pass (`apps/cms/src/services/semantic-drift-scan.ts`):

- **Budget.** At most `maxSemanticItems` items per scan (default 25, maximum 500; a `drift-scan` node option) and a deadline (`semanticTimeBudgetMs`, defaulting to the scan's time budget). The pass resumes from `semantic_scan_cursor` on the intent, separate from the deterministic `scan_cursor`. The scan result's `semantic` object reports `items`, `drift`, `clean`, `unevaluated`, `skipped`, `opened`, `reopened`, `resolved`, `completed` and `cursor`.
- **Who reads.** The scan is a site job, so it reads through `itemServiceForSystem(…, 'semantic-drift-scan')` (`reviewContentAccessForDriftScan`). Only the rule's fields minus the item's pinned fields, plus the context field, are read and sent. Other profile fields are recorded as omitted on the review run.
- **Pinned fields.** A pinned field is never judged. If every judged field is pinned, the rule is skipped for that item, as a field-scoped deterministic rule is.
- **Decision.** Each item is judged through `ReviewService.runReview` as the system principal `system:drift-scan`, so the site opt-in, field allowlist, quota and `ai_decision` audit apply. The audit event records principal `null` and request id `drift:<intentId>`.

## Fingerprint, retry and invalidation

A semantic drift row's `rule_key` is `<key>@v<version>:<profileVersion>:<contentHash>`, and its fingerprint is `intentId:itemId:semantic:<rule_key>`. The content hash is the J05 review hash of exactly what was sent.

- **Retry.** Unchanged content gives the same fingerprint and the same review idempotency key. The stored run is replayed with no second provider call, and no second drift or goal is opened. A run that ended in an error is retried in place. The idempotency key also covers the rule's definition (profile, question, context and fields), so a rule deleted and re-added with another profile under the same key and version gets a new review run instead of the old profile's answer.
- **Invalidation.** A new rule version, a new profile version or changed content gives a new fingerprint. The new state is evaluated, and the old row resolves once that evaluation is conclusive.
- **Removed rules.** Rows of a semantic rule the intent no longer declares resolve on the next scan without any judgement, also when no semantic rule is left and the pass does not run. The scan result reports them as `semanticOrphansResolved`.

## Uncertainty

A provider outage, quota or timeout error, an answer between the thresholds, a missing profile version or an empty context field records an `unevaluated` row carrying the reason code. An `unevaluated` outcome:

- never resolves an earlier drift of that rule on that item (`diffDrifts` leaves those fingerprints alone);
- never creates a goal (the reconciler only takes `open` drift);
- reopens as `open` when a later pass detects the drift, and resolves when a later conclusive pass does not.

The deterministic pass ignores semantic rows, so a scan without the decision path (the dispatcher's verify scan) never resolves semantic drift.

## Goals

Open semantic drift becomes a goal through the existing `ReconcilerService.reconcileIntent`, with the same budget, breaker, kill switch and maintenance window as other drift. The goal is titled `Review semantic drift "<key>" on <collection>/<item>`, and its metadata carries `reviewOnly: true` and `semantic` with the recorded provenance: rule and rule version, profile key and version, question, threshold, content hash, revision, review run id, provider, model, calibrated and the answer. The [repair loop](./reconciler-repair-loop.md) (#455) has no repair skill for semantic drift, so the dispatcher blocks the goal as `HUMAN_REVIEW_REQUIRED`. There is no second approval loop.

## Mission Control

The intent detail lists semantic drift with the rule key and version, the profile and version, the question, the model, the answer and threshold, the revision, the content hash and the review run, all from what the scan recorded. An `unevaluated` row shows its reason code and says the earlier drift is kept. The decision model returns no rationale, so none is shown. The SLO table leaves `unevaluated` rows out of the health ratio and shows them as a separate "not evaluated" count. Health reads `unknown`, not 100 %, when nothing conclusive backs it: the drifts failed to load, every row is `unevaluated`, or the intent has semantic rules and no conclusive row. A clean semantic answer and a pass that was off or unavailable both leave no row, so an empty list cannot tell them apart. The dashboard's SLO health card averages only intents with a known health and counts the unknown ones in its label. For an intent with semantic rules and no drift row, the intent detail says the empty list does not show that the semantic rules pass, instead of "content meets the SLO".

## Multi-tenancy

- **Isolated per site:** intents, drift rows and the semantic cursor (`site_id` on `lumibase_content_intents` and `lumibase_content_drifts`), review profiles and runs, the `aiDecisions` setting and the decision quota keys. Every query of the pass is scoped by `site_id`.
- **Shared per deployment:** the decision provider configuration (`DECISION_*`) and `ENCRYPTION_KEY`, as for draft review.
- **Verified by** `drift-semantic.db.integration.test.ts`: a scan on one site creates no drift or goal on the other.

## Limitations

- No live benchmark yet, so no measured drift precision, recall or false-positive rate.
- Event and schedule Flows runs get the same cache and provider configuration as manual runs on the Docker/Node worker (`registerFlowEventWorker` in `serve.ts`), so a scheduled `drift-scan` runs the semantic pass there; it is still gated by `aiDecisions.enabled` and `aiDecisions.drift`. Cloudflare Workers has no `flow-events` consumer yet (backlog B118), so event and schedule flows do not run there at all.
- Tested with unit tests and a Postgres integration suite, not on a deployed Cloudflare Worker.
