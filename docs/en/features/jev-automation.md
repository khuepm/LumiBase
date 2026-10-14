---
version: 3
sourceLang: en
lastUpdated: 2026-10-14T19:12:34.020Z
contentHash: 30def0af1533c49c
codeVerified: 2026-10-14T19:12:34.020Z
codeVerifiedHash: 30def0af1533c49c
codeVerifiedClaims: 14
---

# Jev automation: tagging and review-queue routing (shadow-first)

Jev automation turns confident [draft-review](./draft-review.md) decisions into metadata proposals inside a [Flow](./flows-automation.md): add a taxonomy tag, or route an item to a review queue. It starts in **shadow mode**: every proposal is recorded and nothing is written to the item. A site goes live only after the held-out benchmark ([Jev benchmark](./jev-benchmark.md)) and the shadow metrics below support it, and even then every write becomes an approval a human decides on.

> **Status.** The code ships with shadow on and no live configuration. Precision and coverage have not been measured on real data yet, so no site should set `mode: 'live'` until `GET /api/v1/ai/automation/metrics` reports `shadowRequired: false` for its locale and action.

## How it fits together

1. A flow built from a template runs `ai:decision` (J10) on one item with a pinned profile version.
2. The next node, `ai:apply-tags` or `editorial:route`, reads that decision and records one row in `lumibase_ai_automation_actions` for the flow run, node and item.
3. The row is **shadow** unless every live condition holds (see [Mode](#mode)). A live row goes through the governed harness, capped at L1, so it parks an approval.
4. Reviewers accept, override or reject the decision from the review queue. The verdict is stored as review feedback on the decision.
5. `GET /api/v1/ai/automation/metrics` computes precision and coverage in the auto-action zone from those rows and verdicts.

## Templates

`GET /api/v1/ai/automation/templates` lists two templates. `POST /api/v1/ai/automation/templates/:key/build` validates the parameters and returns a flow body; it writes nothing. In Studio, **Flows → Create from template** builds the flow and saves it as a **draft, manual-trigger** flow. Activating it stays a separate step.

| Template | Graph | Key parameters |
|---|---|---|
| `taxonomy-tagging` | `ai:decision` (choice) → `ai:apply-tags` | `profileKey`, `profileVersion`, `collection`, `questionKey`, `choices`, `minConfidence`, `tagField`, `tagMap` |
| `editorial-routing` | `ai:decision` (choice or noul) → `editorial:route` | the same, plus `questionType`, `noulThreshold`, `queueField`, `queues`, `manualQueue`, `submitForReview` |

Each choice key (or `true`/`false` for a noul) and `unknown` lead to the action node, so an abstention is recorded as `decision_unknown`. `error` ends the run. Only manual runs carry the principal the nodes act for; event, schedule and webhook runs are refused, as for `ai:decision`.

## Operations

| Operation | Proposes | Never |
|---|---|---|
| `ai:apply-tags` | adds the chosen category (mapped by `tagMap`) to an array-of-strings field | changes `status`, deletes, changes schema |
| `editorial:route` | sets a routing field to the queue mapped by `queues`; with `submitForReview`, names the `submit_review` transition when `canTransition` allows it | performs the transition, publishes |

An `unknown` decision only ever suggests `manualQueue`, and that suggestion is never live.

Before proposing, each node re-resolves the run's principal and re-reads `aiDecisions.enabled` and `aiDecisions.flows`. It reads the decision from the stored review run: the upstream step output only names the run and the question, and its value, confidence, provider, model and profile must agree with the run. Then it **skips and records** (status `skipped`) when:

- the decision is missing, failed (`decision_error`) or abstained (`decision_unknown`);
- the review run is about another collection or item than the node acts on (`decision_item_mismatch`; the row then stores no revision or hash);
- the step output disagrees with the review run's answer or profile (`decision_mismatch`);
- the review run is stale: the item's content hash or latest revision changed since the decision (`stale:content_changed`, `stale:revision_changed`);
- an editor already overrode the decision with feedback `edit` or `reject` (`human_override`);
- the target field is pinned by a human (`pinned`) or the principal cannot read it (`field_not_readable`).

A proposal that changes nothing is `noop`.

## Mode

The `aiDecisions` setting (written by a site admin through `POST /api/v1/settings`) holds the automation block:

```json
{
  "enabled": true,
  "flows": true,
  "automation": {
    "mode": "live",
    "thresholds": {
      "vi": {
        "tag": {
          "provider": "typesafe",
          "model": "jev-1.13",
          "profileKey": "taxonomy",
          "profileVersion": 3,
          "questionKey": "category",
          "minConfidence": 0.85
        }
      }
    },
    "gate": { "approvedBy": "usr_admin", "approvedAt": "2026-11-01T09:00:00Z", "evidenceRef": "eval/jev-benchmark/reports/v1/live/report.heldout.json" }
  }
}
```

A proposal is live only when all of these hold; otherwise it is shadow and `reason` says why:

| Condition | Shadow reason |
|---|---|
| the block parses | `settings_malformed` |
| `mode` is `live` | `mode_shadow` |
| `gate` has `approvedBy`, `approvedAt` and `evidenceRef` | `gate_missing` |
| the item has a locale (`options.locale` or `input.locale`) with a threshold for the action | `locale_unknown`, `threshold_missing` |
| the threshold's `provider`, `model`, `profileKey`, `profileVersion` and `questionKey` match the decision | `provider_mismatch`, `model_mismatch`, `profile_mismatch`, `profile_version_mismatch`, `question_mismatch` |
| the decision's confidence is at least `minConfidence` | `below_threshold` |

A threshold names the exact decision it was measured for. Profile versions are numbered per profile key, so `profileVersion` alone does not identify a profile; a threshold without `profileKey` and `questionKey` does not parse and reads as `settings_malformed`. Take `minConfidence` from the frozen thresholds of the J06 tune split for the same provider, model, profile and question. Shadow rows are `inZone` only against a threshold measured for their decision, so shadow measures exactly the zone a live switch would act in.

## Live writes are governed

A live proposal calls `AISecureHarness.execute('updateItem')` with:

- an ItemService bound to the run's principal (`itemServiceForPrincipal`), so row/field RBAC and the site are that principal's;
- agent provenance on the revision, so a field a human pinned is refused (`PINNED_BY_HUMAN`);
- agent `jev-automation` and `autonomyCap: 1`. The harness resolves the lower of the grant and the cap, so any grant from L2 to L4 still yields **L1: an approval**, and L0 is refused (`AUTONOMY_SHADOW`). Automation never executes a write on its own authority;
- the kill switch, keyed on the `jev-automation` agent (a frozen site or agent is `denied`, reason `frozen`).

The row becomes `pending_approval` with the approval id. When a human approves in Mission Control, the harness performs the write under the requester's re-resolved rights; the row then reads as `applied`. A rejected approval reads as `rejected`.

## Revert

`POST /api/v1/ai/automation/actions/:id/revert` (site admin) restores `previous` through the caller's ItemService. It refuses with:

- `409 AUTOMATION_NOT_APPLIED` for shadow, pending or rejected rows;
- `409 AUTOMATION_REVERT_CONFLICT` when the field no longer holds what the action wrote, so a later human edit wins;
- `409 AUTOMATION_ALREADY_REVERTED` the second time.

## Review queue

The editorial review queue in Studio lists the collection's automation rows under **Automation suggestions**: the proposed tag or queue, the mode and status, the confidence and whether it is in the auto-action zone. **Accept**, **Override** (enter the correct tag or queue; stored as `edit`) and **Reject** post `POST /api/v1/ai/automation/actions/:id/feedback`. They record feedback only; nothing is applied from the queue. A decision whose item changed since asks before recording (`acknowledgeStale`).

Feedback belongs to the decision (review run and question), and one decision can feed both a tag and a route node. So an override is stored in the decision's vocabulary: the CMS maps the tag or queue back to the choice key (or `true`/`false` for a noul) through the node's `tagMap` or `queues`, or takes it as a choice key when it is not mapped. A value the decision cannot take is refused with `422 AUTOMATION_OVERRIDE_UNMAPPED`, and the message lists the values that can be used.

## Audit chain

Every link is an id, so a row can be traced end to end:

input revision (`revision_id`, `content_hash`) → review run (`review_run_id`, provider, model, profile version) → action (this row, `flow_run_id`, `node_id`, `approval_id`) → feedback (review feedback on `review_run_id` + `question_key`).

`GET /api/v1/ai/automation/actions/:id` returns the row with its `chain`. When the review-run retention purge removes a run, `review_run_id` becomes null and the row stays.

## Shadow metrics

`GET /api/v1/ai/automation/metrics?from=&to=` (site admin, window at most 366 days, default the last 30) reports, per action, locale, provider, model, profile (key and version) and question:

- **precision** over in-zone proposals with a verdict from a signed-in user: `accept`, or an override to the same decision value, is right; `reject` or an override to another value is wrong;
- **coverage**: in-zone proposals over decided items (proposals plus abstentions);
- 95% Wilson intervals, the threshold used and sample counts.

Protocol `jev-automation-v1` requires at least 30 reviewed in-zone proposals per split and 100 overall. Below that a split is `insufficientSample` and `shadowRequired` stays `true`. Rows from a provider, model, profile or question the threshold was not measured for are excluded (`excludedMismatch`), so profiles that share a version number are never pooled. The metrics never switch anything on; going live is a separate admin decision recorded in `gate`.

## Access and multi-tenancy

- `/api/v1/ai/automation/*` is control plane: the control-plane backstop and each route require a site admin. The review queue shows non-admins a note instead of the list.
- Shared across the deployment: nothing new. Isolated per site: every row of `lumibase_ai_automation_actions` (`site_id`, FK cascade, in `rls-policies.sql`), every store query, the approval and the review run it links to.
- Verified by tests: the store refuses another site's row on read, update and revert (DB integration), list and feedback joins are site scoped, and a principal of another site does not resolve in a node.

## Known limits

- **No measured precision yet.** There is no real data, so every site stays in shadow.
- **Manual runs only.** Event and schedule triggers carry no principal, so the nodes refuse them.
- **An approval is not re-checked for staleness.** The decision is checked when the proposal is made; if the item changes before a human approves, the approval writes the proposed value. Review the approval, or revert afterwards.
- **A crashed delivery stays `pending`.** A live row is claimed before the harness call; if the process dies in between, a redelivery finds the row and proposes nothing. Re-run the flow to propose again.
- **The `submit_review` transition is proposed, not performed.** A reviewer submits the item for review.
