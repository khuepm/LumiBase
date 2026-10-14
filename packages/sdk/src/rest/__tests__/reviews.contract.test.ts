/**
 * The SDK has no runtime dependencies, so it mirrors the CMS review contracts
 * instead of importing them. These assertions keep the mirror honest: they
 * are checked by `tsc` (`pnpm -F @lumibase/sdk typecheck`), so any drift
 * between the SDK types and `@lumibase/contracts` fails the typecheck.
 *
 * `@lumibase/contracts` is a devDependency used here only, through
 * `import type` — nothing of it reaches the published bundle.
 */
import { describe, expectTypeOf, it } from "vitest";

import type {
  ReviewErrorCode as ContractReviewErrorCode,
  ReviewFeedback as ContractReviewFeedback,
  ReviewFeedbackRequest as ContractReviewFeedbackRequest,
  ReviewPreset as ContractReviewPreset,
  ReviewProfile as ContractReviewProfile,
  ReviewQuestion as ContractReviewQuestion,
  ReviewRun as ContractReviewRun,
  ReviewRunRequest as ContractReviewRunRequest,
  ReviewRunStatus as ContractReviewRunStatus,
  ReviewStaleReason as ContractReviewStaleReason,
  ReviewVerdict as ContractReviewVerdict,
} from "@lumibase/contracts/schemas";

import type { DecisionErrorCode, DecisionQuestion } from "../decisions";
import type {
  ReviewFeedback,
  ReviewFeedbackEntry,
  ReviewFeedbackRequest,
  ReviewPreset,
  ReviewProfile,
  ReviewRun,
  ReviewRunRequest,
  ReviewRunStatus,
  ReviewStaleReason,
  ReviewVerdict,
} from "../reviews";

describe("review types mirror @lumibase/contracts", () => {
  it("enums", () => {
    expectTypeOf<ReviewPreset>().toEqualTypeOf<ContractReviewPreset>();
    expectTypeOf<ReviewRunStatus>().toEqualTypeOf<ContractReviewRunStatus>();
    expectTypeOf<ReviewVerdict>().toEqualTypeOf<ContractReviewVerdict>();
    expectTypeOf<ReviewStaleReason>().toEqualTypeOf<ContractReviewStaleReason>();
  });

  it("questions are the decision question shapes", () => {
    expectTypeOf<DecisionQuestion>().toEqualTypeOf<ContractReviewQuestion>();
  });

  it("requests equal z.infer of the request schemas", () => {
    expectTypeOf<ReviewRunRequest>().toEqualTypeOf<ContractReviewRunRequest>();
    expectTypeOf<ReviewFeedbackRequest>().toEqualTypeOf<ContractReviewFeedbackRequest>();
    expectTypeOf<ReviewFeedbackEntry>().toEqualTypeOf<ContractReviewFeedbackRequest["entries"][number]>();
  });

  it("responses equal the contract response types", () => {
    expectTypeOf<ReviewProfile>().toEqualTypeOf<ContractReviewProfile>();
    expectTypeOf<ReviewFeedback>().toEqualTypeOf<ContractReviewFeedback>();
    // The SDK narrows `answers` to the decision answer shapes the CMS stores;
    // everything else is identical, and the SDK run is assignable to the contract run.
    expectTypeOf<Omit<ReviewRun, "answers">>().toEqualTypeOf<Omit<ContractReviewRun, "answers">>();
    expectTypeOf<ReviewRun>().toMatchTypeOf<ContractReviewRun>();
  });

  it("DecisionErrorCode carries every review error code", () => {
    expectTypeOf<Extract<DecisionErrorCode, `REVIEW_${string}`>>().toEqualTypeOf<ContractReviewErrorCode>();
  });
});
