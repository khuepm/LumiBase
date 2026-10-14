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
  reviewDraft,
  submitReviewFeedback,
  type ReviewRun,
} from "@lumibase/sdk";

export async function reviewPostDraft(
  token: string,
  draft: { title: string; body: string },
  signal?: AbortSignal,
): Promise<ReviewRun | null> {
  const client = createLumiClient({ url: "https://cms.example.com", siteId: "site_1", token });

  const [profile] = await client.request(listReviewProfiles({ collection: "posts" }, { signal }));
  if (!profile) return null; // no review profile configured for this collection

  try {
    const run = await client.request(
      reviewDraft(
        {
          profile: profile.key,
          profileVersion: profile.version,
          collection: "posts",
          snapshot: draft,
          // Retrying with the same key returns the same run, no second provider call.
          idempotencyKey: `draft:${profile.key}@${profile.version}:${draft.title}`,
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

    await client.request(
      submitReviewFeedback(run.id, {
        entries: [{ questionKey: "category", verdict: "accept" }],
        // Snapshot runs: the hash of the draft the editor sees now.
        contentHash: run.contentHash,
      }),
    );
    return run;
  } catch (err) {
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
      case "REVIEW_STALE":
        return null; // the draft changed: run the review again
      default:
        throw err;
    }
  }
}
