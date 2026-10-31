---
version: 4
sourceLang: en
lastUpdated: 2026-10-26T15:54:53.960Z
contentHash: 7cdbfd6d6b58b528
codeVerified: 2026-10-26T15:54:53.960Z
codeVerifiedHash: 7cdbfd6d6b58b528
codeVerifiedClaims: 30
---

# Draft-review pilot (Jev)

The pilot tests whether [draft review](./draft-review.md) makes editors faster without making them accept bad suggestions, before any automation is turned on. It runs per site, on collections a site admin picks, in two phases: **baseline** (the review panel is hidden and only editor time is measured) and **assisted** (the panel is shown).

**Status: no measured results yet.** The metrics endpoint, the report and the controls exist; no real pilot has run. The committed report `apps/cms/eval/jev-pilot/reports/jev-pilot-v1.template.md` is an empty template, and there is no go/no-go decision. Rolling draft review out beyond the pilot, or turning on automation, is a separate decision that needs its own approval.

Code: `apps/cms/src/services/review-metrics.ts`, `apps/cms/src/routes/ai-review.ts`, `apps/cms/eval/jev-pilot/report.ts`, `apps/cms/scripts/jev-pilot-report.ts`, `apps/studio/src/modules/settings/ai-decisions-settings.tsx`, `apps/studio/src/modules/content/use-review-pilot.ts`.

## Pre-registered protocol (`jev-pilot-v1`)

The criteria, minimum samples and acceptable error below are fixed **before** data is collected. They are versioned in code as `PILOT_PROTOCOL` in `review-metrics.ts`. Changing any of them means a new protocol version and a new pilot, not a second look at the same data. The report refuses metrics from another protocol version.

**Minimum samples.** Below these counts a result is reported but flagged `insufficientSample`, and it cannot pass.

| Sample | Minimum |
|---|---|
| Real review sessions per mode (baseline and assisted each) | 100 |
| Viewed suggestions | 100 |
| Completed runs | 100 |
| Each split (locale, provider, profile version) | 30 |
| Suggestions checked by a human adjudicator | 50 |

**Acceptable error.** A rate is conclusive only when its 95% Wilson interval has a half-width of at most 0.10. A rate passes only when the whole interval is on the right side of the threshold. When the point estimate meets the threshold but the interval does not, the status is `inconclusive`. `time_reduction` and `latency_p95` have no interval: they pass or fail on a point estimate (the ratio of two medians, and the p95). Treat a `time_reduction` ratio close to 0.80 as unresolved, not as a clear pass or fail. Adding an interval would be a new protocol version.

**Success criteria.** All must pass.

| Criterion | Passes when |
|---|---|
| `time_reduction` | median assisted time per item ≤ 0.80 × median baseline time |
| `rejection_rate` | upper 95% bound of rejects over viewed suggestions ≤ 0.30 |
| `coverage` | lower 95% bound of completed runs that did not abstain ≥ 0.80 |
| `error_rate` | upper 95% bound of finished runs that errored ≤ 0.10 |
| `latency_p95` | p95 provider latency of completed runs ≤ 10,000 ms |
| `adjudicated_error_rate` | upper 95% bound of adjudicated suggestions judged wrong ≤ 0.10 (report only) |

**Decision.** `go` only when every criterion passes, including adjudication. `no_go` when any criterion fails on a sufficient sample. Otherwise `insufficient_data`: a sample is too small, an interval straddles a threshold, adjudication was not recorded, or the metrics were truncated. A `go` is a recommendation for the approver of the next step, not an automatic rollout.

## What is measured

- **Session.** One editor session runs from opening the editor (a saved item or the new-item form) to the first successful save, on a pilot collection. Later saves in the same open editor are not new sessions. Sessions longer than two hours count as idle: they are excluded from time metrics and reported as `idleSessionsExcluded`.
- **Time per item.** p50, p95 and mean of session duration, baseline and assisted separately, and the ratio of the two medians.
- **Editors only.** Only signed-in users count. `POST /api/v1/ai/reviews/sessions` refuses API keys and the dev principal with `403 FORBIDDEN`. The metrics also drop any session or verdict that does not come from a user, so an integration key that runs and accepts reviews adds no editor time and no viewed suggestions.
- **Viewed suggestions.** The suggestions of a run that the Studio rendered to the editor in an assisted session (`viewedQuestions`). Accept, edit, reject and no-action rates are computed over viewed suggestions only, and only the viewing editor's own verdict counts. Feedback sent without a viewing session, for example straight through the API, is not counted.
- **Operations.** Coverage (completed runs that did not abstain), abstention, error rate, latency p50/p95, and tokens per run where the provider reported both counts.
- **Splits.** By content locale, by provider and by profile version (`key@vN`), each with its own sample count and flag.
- **Sample concentration.** `sampleCounts.distinctEditors` and `sampleCounts.distinctItems` give the number of different editors and items behind each mode's sessions. Each new-item form counts as its own item. The minimums count sessions, so check these numbers before you treat a minimum as met.

API calls and run counts are never reported as user value. They appear only as denominators for coverage, errors and latency.

## Setup

1. **Profile.** A site admin creates a review profile for the collection (`POST /api/v1/ai/review-profiles`, see [draft review](./draft-review.md)).
2. **People.** Grant the pilot editors the `ai:decide` capability (`create` on the `lumibase_ai_decisions` permission collection). Editors without it see the plain editor and record no sessions. The capability works for Studio users and secret API keys only: publishable API keys and frontend sessions get `403 FORBIDDEN` even with it.
3. **Baseline.** In Studio, **Settings → AI decisions**: turn on **Run the draft-review pilot**, choose the collections (at most 100) and keep the mode **Baseline**. No content is sent anywhere in this phase, so the site does not need to opt in to the provider yet. Collect at least 100 sessions.
4. **Assisted.** Turn on **Send content to the decision provider**, switch the mode to **Assisted** and save. Collect at least 100 assisted sessions. Keep the same collections, editors and kind of work as in the baseline.
5. **Adjudication.** A person who did not author the content checks a random sample of at least 50 viewed suggestions and records `{ "sampled": 50, "errors": 3, "adjudicators": 1 }` in a JSON file. The system does not collect this.
6. **Report.** A site admin exports the metrics and builds the report:

```bash
curl -H "Authorization: Bearer $TOKEN" -H "X-Lumi-Site: $SITE" \
  "$CMS/api/v1/ai/reviews/metrics?from=2026-11-01&to=2026-12-01" > metrics.json
pnpm -F @lumibase/cms pilot:report -- --metrics metrics.json --adjudication adjudication.json
```

The report is written to `apps/cms/eval/jev-pilot/reports/` as JSON and Markdown, with the protocol version, sample counts, every criterion with its status, the decision and its limitations. `pnpm -F @lumibase/cms pilot:report -- --template` writes the empty template.

## Permissions

| Action | Needs |
|---|---|
| Change the pilot or the kill switch (`POST /api/v1/settings`, key `aiDecisions`) | site admin |
| Read the pilot mode, run a review, give feedback | `ai:decide` (not a publishable API key or frontend session) |
| Record a session | `ai:decide`, as a signed-in user (not an API key) |
| Read the metrics (`GET /api/v1/ai/reviews/metrics`) | site admin |

## Data sent to the provider

- **Baseline:** nothing.
- **Assisted:** only the fields the review profile lists, read with the editor's own row and field permissions, plus the profile's questions. The provider key stays on the CMS.
- **Stored by LumiBase:** runs (answers and provenance, not the content), feedback verdicts, and sessions (duration, mode, locale, run id and viewed question keys, no content). Runs and their feedback are purged after `DECISION_REVIEW_RETENTION_DAYS` (default 180). The purge keeps sessions and clears their run reference.

## Uncertainty states

- **Not enough information** in the editor: the run abstained. Its suggestions are shown, but accepting a field value is disabled.
- **`insufficient_sample`** in metrics and reports: below the pre-registered minimum. Not a result.
- **`inconclusive`**: enough data, but the interval straddles the threshold. Not a pass.
- Provider probabilities are not correctness probabilities unless the provider is calibrated on this data. The editor shows the provider's own `calibrated` claim.

## Rollback and disable

- **Kill switch.** **Settings → AI decisions → Turn everything off** sets `aiDecisions.enabled` and `aiDecisions.review.enabled` to `false` in one write. The stored collection list and mode are kept, so turning the pilot back on is one step. Unsaved edits on the page are discarded, not saved.
- **API equivalent.** Read the current value with `GET /api/v1/settings/aiDecisions`, then `POST /api/v1/settings` with `{ "key": "aiDecisions", "value": { ...current, "enabled": false, "review": { ...current.review, "enabled": false } } }`.
- **Effect.** The panel disappears and the editor works as before. `POST /api/v1/ai/reviews`, new feedback and new sessions return `403 DECISION_DISABLED`. In-flight Studio requests fail with the same code.
- **Nothing is deleted.** Drafts, items, runs, feedback, sessions and audit events stay. Run history (`GET /api/v1/ai/reviews?collection=&itemId=`, `GET /api/v1/ai/reviews/:id`) and the metrics stay readable.
- **Rollback of a version.** The migration `0020_jev_review_sessions` only adds a table. Rolling back the CMS leaves it unused.

## Multi-tenancy

- **Isolated per tenant:** the `aiDecisions` setting, sessions, runs, feedback and metrics. Every query filters by `site_id`, and `lumibase_review_sessions` is in `rls-policies.sql`.
- **Shared:** the provider credentials and the deployment-wide quota ceilings (unchanged from [the decision API](../api/hono-api-spec.md#8-ai-copilot)).
- **Checked by:** `apps/cms/src/routes/__tests__/ai-review.test.ts` (pilot gating, session RBAC, another site's run refused, metrics count only the caller's site) and `apps/cms/src/services/__tests__/review-sessions.db.integration.test.ts` (site-scoped metrics on Postgres; turning the pilot off or the kill switch keeps every row).

## Desktop and mobile shell

The rollout and session calls go through `getApiClient()`, so they use `getApiBaseUrl()` and the token store like the rest of the Studio.

## Limitations

- Sessions see only time in the editor. Research or time spent elsewhere is not measured.
- Baseline and assisted are compared as groups, not paired per item or editor. Keep the editors and kind of work stable across the phases.
- A session records the last run the editor saw. Feedback on an earlier run in the same session is not counted.
- Adjudication is recorded by hand outside the system.
- Sessions are reported by the editor's client. A signed-in user could post them straight to the API, and they are not de-duplicated per editor or item, so one editor reopening the same item many times still adds sessions. Check the distinct editor and item counts. The human adjudication step is still required before `go`.
- `time_reduction` is a point estimate with no interval (see Acceptable error).
