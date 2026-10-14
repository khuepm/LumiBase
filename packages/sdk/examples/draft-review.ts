/**
 * Consumer example: review an unsaved draft, show the suggestion, record the
 * editor's verdict. Imports only the public entry `@lumibase/sdk`.
 *
 * The client carries the user's LumiBase session token. No TypeSafe,
 * OpenRouter or other provider key belongs here: the CMS holds those, so this
 * code is safe to run in a browser.
 *
 * Typechecked by `pnpm -F @lumibase/sdk typecheck:examples`.
 */
import {
  createLumiClient,
  decisionErrorCode,
  listReviewProfiles,
  LumiError,
  reviewContentHash,
  reviewDraft,
  submitReviewFeedback,
  type LumiClient,
  type ReviewRun,
} from "@lumibase/sdk";

type PostDraft = { title: string; body: string };

export function cmsClient(token: string): LumiClient {
  return createLumiClient({ url: "https://cms.example.com", siteId: "site_1", token });
}

/** Review the draft as it is now. `null` when there is nothing to show. */
export async function reviewPostDraft(
  client: LumiClient,
  draft: PostDraft,
  signal?: AbortSignal,
): Promise<ReviewRun | null> {
  const [profile] = await client.request(listReviewProfiles({ collection: "posts" }, { signal }));
  if (!profile) return null; // no review profile configured for this collection

  try {
    // The CMS replays a run by (site, principal, idempotencyKey) and ignores the
    // content, so the key has to change whenever the draft or the profile
    // version does. 40 hex chars keep it under the 128-char limit for any
    // profile key.
    const hash = await reviewContentHash(draft);
    const run = await client.request(
      reviewDraft(
        {
          profile: profile.key,
          profileVersion: profile.version,
          collection: "posts",
          snapshot: draft,
          // Retrying the same draft returns the same run, no second provider call.
          idempotencyKey: `${profile.key}@${profile.version}:${hash.slice("sha256:".length, "sha256:".length + 40)}`,
        },
        { signal },
      ),
    );

    if (run.status === "abstained") return run; // "not enough information": show no suggestion
    const answer = run.answers?.category;
    if (answer?.type === "choice") {
      // `calibrated: false` means the probabilities are self-reported by an LLM.
      console.log(answer.choice, answer.confidence, run.calibrated ? "calibrated" : "uncalibrated");
    }
    return run;
  } catch (err) {
    return handleReviewError(err);
  }
}

/**
 * The editor accepts the suggested category. `currentDraft` is the draft as
 * the editor sees it at click time, which may differ from the reviewed one.
 * Returns `false` when the draft changed since the review.
 */
export async function acceptCategory(client: LumiClient, run: ReviewRun, currentDraft: PostDraft): Promise<boolean> {
  try {
    await client.request(
      submitReviewFeedback(run.id, {
        entries: [{ questionKey: "category", verdict: "accept" }],
        // The CMS cannot re-read an unsaved draft, so it compares this hash with
        // the one it reviewed. Sending `run.contentHash` back would always match.
        contentHash: await reviewContentHash(currentDraft),
      }),
    );
    return true;
  } catch (err) {
    if (decisionErrorCode(err) === "REVIEW_STALE") return false; // review the current draft again
    throw err;
  }
}

function handleReviewError(err: unknown): null {
  switch (decisionErrorCode(err)) {
    case "DECISION_DISABLED":
      return null; // the site has not opted in: hide the review action
    case "DECISION_QUOTA_EXCEEDED":
    case "DECISION_CONCURRENCY_LIMITED":
      console.warn(`Try again in ${(err as LumiError).retryAfter ?? 60}s`);
      return null;
    case "DECISION_TIMEOUT":
    case "DECISION_UNAVAILABLE":
      return null; // the provider did not answer; never treat it as "passed"
    default:
      throw err;
  }
}
