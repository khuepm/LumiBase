---
version: 3
sourceLang: en
lastUpdated: 2026-10-14T15:33:32.071Z
contentHash: 32d37bd869afa977
codeVerified: 2026-10-14T15:33:32.071Z
codeVerifiedHash: 32d37bd869afa977
codeVerifiedClaims: 16
---

# Draft review in Studio

The item editor has a **Draft review** panel. It runs one of the site's review profiles (the `/api/v1/ai/review-profiles` and `/api/v1/ai/reviews` endpoints in [AI Copilot](../api/hono-api-spec.md#8-ai-copilot)) on the content being edited and lists one suggestion per profile question. A review only suggests: it never saves, publishes or changes an item on the server.

Code: `apps/studio/src/modules/content/draft-review-panel.tsx`, `apps/studio/src/modules/content/use-draft-review.ts`, `apps/studio/src/modules/content/draft-review-hash.ts`.

## Where it appears

- **Saved item** (`item-detail.tsx`): the panel sits in the side column. When the reviewed fields are unchanged, the CMS reviews the saved item itself (`itemId`), reading it under your permissions and recording its latest revision. When you have unsaved changes to those fields, it reviews the unsaved values instead.
- **New item** (`item-create.tsx`): the panel reviews the unsaved form. Only profile fields you may both read and create are sent; the panel says which fields were not reviewed.

The panel lists the active profiles for the collection. With more than one, a selector picks the profile.

The panel is shown only while the collection is in the draft-review pilot in `assisted` mode (`GET /api/v1/ai/reviews/rollout`). In `baseline` mode, when the pilot is off, or when the mode cannot be read (for example without `ai:decide`), the editor has no panel and works as before. Site admins switch this under **Settings → AI decisions**; see [Draft-review pilot](./jev-draft-review-pilot.md).

## Suggestions and actions

Each suggestion shows the question, the answer and the profile's own criteria text:

- **choice**: the suggested option with its probability and confidence, plus the most likely options. `unknown` shows as "Not enough information" and `other` as "None of the categories fits".
- **score**: the most likely level and the probability of every level.
- **noul**: yes or no with its probability.

The provider and model are shown with a **Calibrated (provider claim)** or **Not calibrated** badge. Jev returns no reasoning, so the panel shows no rationale or citations.

Every suggestion has three actions. Each records one verdict per run and question through `POST /api/v1/ai/reviews/:id/feedback`:

| Action | Feedback | Changes the form |
|---|---|---|
| Accept | `accept` | Only for a `choice` question whose key is a field of the collection: sets that field to the suggested option |
| Edit | `edit` with your value | Same rule: sets that field to the value you picked |
| Reject | `reject` | Never |

The value is applied only after the CMS has stored the feedback. Applying changes the draft in the editor, nothing else. You keep the result with the usual **Save** button, and publishing still needs the editorial actions and their permissions.

A suggestion for a **pinned** field, or for a field you may not write, is shown read-only: Accept and Edit are disabled and Reject stays available. Score and noul questions never change a field; their Accept and Edit record feedback only.

## Stale results

When a review starts, the panel keeps the canonical JSON of the reviewed content (the same form the CMS hashes). If that content changes before or after the answer arrives, the result becomes **stale**: Accept and Edit are disabled and the button reads **Run again**. A 409 `REVIEW_STALE` from the CMS (for example after the item was saved by someone else) leads to the same state. A stale result never overwrites newer edits.

For unsaved drafts, feedback carries the hash of the draft as you see it now, so the CMS can refuse a verdict about content that changed.

## States

| State | When |
|---|---|
| Not set up | no active profile for the collection, `REVIEW_PROFILE_NOT_FOUND`, or `DECISION_NOT_CONFIGURED` |
| Turned off | `DECISION_DISABLED` for the site |
| No permission | `FORBIDDEN` (the `ai:decide` capability is missing) |
| Budget used up | `DECISION_QUOTA_EXCEEDED`, `DECISION_CONCURRENCY_LIMITED` or `DECISION_RATE_LIMITED`, with the `Retry-After` wait when present |
| Timed out | `DECISION_TIMEOUT` |
| Provider unavailable | `DECISION_UNAVAILABLE`, `DECISION_UPSTREAM`, `DECISION_AUTH`, `DECISION_PARSE_FAILED`, `DECISION_VALIDATION` or `DECISION_QUOTA_UNAVAILABLE` |
| Not enough information | the run is `abstained`: suggestions are shown, Accept of a field value is disabled, Edit stays available |

Every failure says that nothing was checked. No error is shown as a pass. **Cancel review** aborts the request, and leaving the editor aborts it too.

## Multi-tenancy and permissions

- **Isolated per tenant:** profiles, runs and feedback. Every call carries the active site in `X-Lumi-Site`, and the CMS scopes reads and writes by `site_id`.
- **Shared:** nothing new. The provider key stays on the CMS; the Studio never sees it.
- Item reviews run under the caller's own row and field permissions. Snapshot reviews only send fields the caller may read and write.
- Verified by `apps/studio/src/modules/content/__tests__/draft-review-panel.test.tsx` (editor flow, stale race, read-only and pinned fields, reviewer without write access, cancel, error states, Vietnamese) and by the CMS route tests in `apps/cms/src/routes/__tests__/ai-review.test.ts` (cross-site and permission checks).

## Desktop and mobile shell

Calls go through `getApiClient()`, so they use `getApiBaseUrl()` and the token store (OS keychain in the shell). `apps/studio/src/lib/__tests__/draft-review-api.test.tsx` checks the base URL, bearer and site header against a runtime CMS origin.

## Language

The panel copy ships in `apps/studio/src/locales/en/content.json` and `apps/studio/src/locales/vi/content.json` and follows the active i18next language.
