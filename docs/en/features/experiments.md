---
sourceLang: en
version: 3
lastUpdated: 2026-11-20T06:20:32.124Z
contentHash: 41a7d799fc101f91
codeVerified: 2026-11-20T06:20:32.124Z
codeVerifiedHash: 41a7d799fc101f91
codeVerifiedClaims: 16
---

# A/B experiments

An **experiment** splits a page's or an item's traffic between **arms** and
counts which arm converts better (#763, epic #678). The report lives in
Insights, an agent can propose the winner, and the winner is promoted only
after a human approves it.

Experiments build on [Personalisation](./personalisation.md): an arm
overrides content the same way a variant does, and delivery keys its caches
by the assigned arm in the same way it keys them by audience.

## 1. Create an experiment

```http
POST /api/v1/experiments
{
  "key": "hero",
  "name": "Hero headline",
  "hypothesis": "A shorter headline gets more sign-ups.",
  "subjectType": "page",
  "subjectId": "<page id>",
  "goal": "signup",
  "minSampleSize": 500,
  "arms": [
    { "key": "control", "weight": 50 },
    { "key": "b", "weight": 50, "overrides": { "title": "Ship content faster" } }
  ]
}
```

- `subjectType` is `page` (overrides `{ title?, layoutConfig? }`) or `item`
  (overrides are a partial `data` object).
- There are 2–4 arms. One must be `control`, which serves the published
  content and has no overrides. Every other arm changes at least one field.
- `weight` is the arm's share of traffic relative to the other arms (0–100).
  An arm with weight 0 gets no traffic.
- `goal` is the conversion name the frontend reports (for example `signup`).
- `minSampleSize` is the number of exposures every arm needs before a winner
  is recommended (default 100).

A new experiment is a `draft` and changes nothing. Then:

| Call | From → to |
|---|---|
| `POST /api/v1/experiments/:id/start` | `draft` or `stopped` → `running` |
| `POST /api/v1/experiments/:id/stop` | `running` → `stopped` |
| `PATCH /api/v1/experiments/:id` | name, hypothesis, goal, `minSampleSize`; `arms` only while `draft` |
| `DELETE /api/v1/experiments/:id` | any state except `running` |

Only one experiment runs per page or item (`409 SUBJECT_BUSY`), and at most 5
run per site (`409 TOO_MANY_RUNNING`), because each one multiplies the cached
copies of the pages it touches.

## 2. Traffic split at delivery

`GET /api/v1/deliver/page/:site_id/:slug` takes the site's running
experiments that can touch the page: page experiments on that slug and every
item experiment. It assigns the visitor an arm from two request headers:

- `X-Lumi-Visitor`: the site's own opaque, first-party visitor id
  (8–128 characters of `A-Z a-z 0-9 _ -`).
- `X-Lumi-Consent: analytics`. `DNT: 1` or `Sec-GPC: 1` withdraw it.

The assignment is deterministic: the same visitor always sees the same arm,
and nothing about the visitor is stored. Each experiment uses its own salt,
so two experiments split independently.

Without consent or without a visitor id, the visitor gets the `control`
content and is not in the experiment.

The response then carries:

- the arm's content (an experiment arm wins over an audience variant on the
  same page);
- `experiments: [{ key, arm }]` in the payload and
  `X-Lumi-Experiments: key=arm,…`, for the experiments that touched this page
  and that the visitor is in;
- `Vary` with `X-Lumi-Visitor` and the consent headers.

Every cache tier is keyed by the assigned arms, never by the visitor id: the
edge key gets `__exp=hero:b`, the app-cache key and the `ETag` include it too.
A page under a two-arm test has at most three copies: `b`, `control`, and
"not in the experiment".

## 3. Report exposures and conversions

The frontend reports what it showed and what converted to the public beacon,
with the same visitor id the page was delivered with:

```http
POST /api/v1/experiment-events/:site_id
X-Lumi-Consent: analytics
X-Lumi-Visitor: <the site's visitor id>

{ "events": [
  { "experiment": "hero", "arm": "b", "kind": "exposure" },
  { "experiment": "hero", "arm": "b", "kind": "conversion", "goal": "signup" }
] }
```

The metric is **per visitor**, which is what the report's statistics assume:
each visitor is one trial that converts or not.

- **Once per visitor.** A visitor counts once per experiment, in the arm
  deterministic assignment gives them. An event for another arm is not
  counted, so a client cannot credit an arm it was not shown.
- **Exposure.** An exposure is counted the first time. Replays change nothing.
- **Conversion.** A conversion must name the experiment's `goal`. It counts
  only after an exposure of the same visitor to the same arm, and only once.
  Conversions therefore never exceed exposures.

The beacon answers `204` whether or not an event counted. It answers `400`
only for a malformed request:

- a conversion without `goal`;
- a missing or malformed `X-Lumi-Visitor`;
- an invalid body.

Events are dropped for bots and without analytics consent; `DNT` and
`Sec-GPC` withdraw consent. At most 10 events are accepted per call, and the
route is rate-limited like the pageview beacon.

The visitor id is never stored. Each participant is kept as SHA-256 of
`<experiment id>:<visitor id>`: one-way, and salted per experiment so it cannot
be linked across experiments. Participants are deleted with their experiment.

`@lumibase/analytics-consent` has the helpers:

```ts
import { experimentsFromHeaders, exposuresFor, conversionsFor, sendExperimentEvents } from '@lumibase/analytics-consent';

const arms = experimentsFromHeaders(res.headers);
await sendExperimentEvents(consent, exposuresFor(arms), { cmsUrl, siteId, visitor });
// later, on sign-up:
await sendExperimentEvents(consent, conversionsFor(arms, 'signup'), { cmsUrl, siteId, visitor });
```

## 4. The report (Insights)

`GET /api/v1/experiments/:id/report` returns, per arm:

- exposures, conversions and the conversion rate;
- `uplift`: the relative change against control;
- `z` and `pValue` from a two-proportion z-test against control;
- `significant`: true when `pValue` is under 0.05, divided by the number of
  challenger arms (Bonferroni).

Exposures and conversions are visitors. If an arm's counts were ever not a
valid per-visitor sample (conversions above exposures, say), it is listed in
`invalidArms`, and no significance or recommendation is computed.

It also returns `sampleReached`, the daily series, and a `recommendation`:

| Recommendation | When |
|---|---|
| `null` | some arm has fewer than `minSampleSize` exposures, or no arm differs significantly |
| a challenger arm | it beats control significantly (the best one, if several do) |
| `control` | every challenger is significantly worse |

Studio shows it under **Insights → Experiments**: the arms table, the
recommendation, start / stop, and *Request promotion*.

## 5. Promoting the winner (approval)

Promotion always goes through an approval (HITL):

- `POST /api/v1/experiments/:id/promote { arm, rationale? }` does not promote.
  It parks a `promoteExperimentWinner` approval and answers `202` with its
  `approvalId`.
- An agent does the same: `analyzeExperiment({ experimentId })` reads the
  report, and `promoteExperimentWinner({ experimentId, arm, rationale? })` is
  a governed skill (`dangerous`), so it waits for approval like other
  control-plane actions.

When a reviewer approves, the winning arm becomes the published content. A
page's title and layout change through the page service; an item's fields
change through the item service, so validation, revisions and permissions
apply as for any edit. The experiment ends as `completed` with `winnerArm`
set, and delivery stops splitting. Promoting `control` changes no content.

On approval, the requester's current rights are checked again. An experiment
that is already `completed` cannot be promoted a second time.

## Data and tenancy

Migration `0045_experiments` adds three tables, each with `site_id` and
row-level security:

- `lumibase_experiments`;
- `lumibase_experiment_arms`;
- `lumibase_experiment_participants`: one row per visitor, holding the
  hashed visitor, the arm, `exposed_at` and `converted_at`.

Every query filters by site. Delivery and the beacon take the site from the
URL. The running list is cached per site for 60 seconds and dropped on every
change.

## Not done yet

- Creating and editing experiments in Studio. Studio shows the report; you
  create experiments through the API or an agent.
- Sequential testing, bandits and variance reduction: the test is a fixed
  two-proportion z-test.
- Goals defined from pageviews or CDC events. Conversions are reported by the
  frontend.
