/**
 * SDK command for the decision model endpoint (`POST /api/v1/ai/decisions`):
 * typed `noul` / `choice` / `score` questions answered with probabilities by
 * TypeSafe Jev or the configured equivalent. Command factory
 * `(client) => Promise<T>`, matching the rest of the REST module.
 *
 * Provider keys never reach the SDK: the CMS holds them and the client only
 * sends its usual bearer + `X-Lumi-Site` headers.
 */

import { LumiError, type LumiClient, type LumiErrorBody } from "../client";

/** Free-form payload: plain text or structured data. */
export type DecisionPayload = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: "noul";
  instructions: DecisionPayload;
  criteria: { true: DecisionPayload; false: DecisionPayload };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: DecisionPayload;
  /** Option key → description, or `null` when the key is self-explanatory. 2–255 options. */
  criteria: Record<string, DecisionPayload | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: DecisionPayload;
  /** Ordered rubric levels, lowest first. 2–10 levels. */
  criteria: DecisionPayload[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface DecisionRequest {
  state: DecisionPayload;
  /** 1–32 questions keyed by `[A-Za-z0-9_-]{1,64}`. */
  questions: Record<string, DecisionQuestion>;
}

export interface NoulAnswer {
  type: "noul";
  /** P(the `true` criterion holds), 0..1. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionResult {
  /** `typesafe`, `openrouter` or `llm`. */
  provider: string;
  model: string;
  /**
   * `false` when `DECISION_PROVIDER=llm`: probabilities are self-reported by
   * the LLM. `true` is the provider's claim, not a calibration on your data.
   */
  calibrated: boolean;
  answers: Record<string, DecisionAnswer>;
  /** `null` when the provider did not report the count (unknown, not zero). */
  usage: { inputTokens: number | null; outputTokens: number | null };
}

/**
 * Every `errors[0].code` the decision and draft review endpoints return
 * (`POST /ai/decisions`, `/ai/review-profiles*`, `/ai/reviews*`), carried on
 * `LumiError.body`. Read it with {@link decisionErrorCode}.
 */
export const DECISION_ERROR_CODES = [
  "VALIDATION",
  "FORBIDDEN",
  // Governance (#511): checked before the provider is called.
  "DECISION_DISABLED",
  "DECISION_FIELD_NOT_ALLOWED",
  "DECISION_QUOTA_EXCEEDED",
  "DECISION_CONCURRENCY_LIMITED",
  "DECISION_QUOTA_UNAVAILABLE",
  // Provider and limits (#504, #509).
  "DECISION_NOT_CONFIGURED",
  "DECISION_AUTH",
  "DECISION_VALIDATION",
  "DECISION_RATE_LIMITED",
  "DECISION_UNAVAILABLE",
  "DECISION_UPSTREAM",
  "DECISION_PARSE_FAILED",
  "DECISION_TIMEOUT",
  "DECISION_CANCELLED",
  "DECISION_INPUT_TOO_LARGE",
  // Draft review (#512).
  "REVIEW_PROFILE_NOT_FOUND",
  "REVIEW_PROFILE_EXISTS",
  "REVIEW_PROFILE_CONFLICT",
  "REVIEW_ITEM_NOT_FOUND",
  "REVIEW_RUN_NOT_FOUND",
  "REVIEW_FIELD_NOT_ALLOWED",
  "REVIEW_COLLECTION_MISMATCH",
  "REVIEW_NOT_COMPLETE",
  "REVIEW_STALE",
  "INTERNAL",
] as const;

export type DecisionErrorCode = (typeof DECISION_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(DECISION_ERROR_CODES);

/**
 * The typed `errors[0].code` of a rejected decision or review call, or `null`
 * when `err` is not a `LumiError` with a known code (network failure, abort,
 * or a code this SDK version does not know — read `err.body` for those).
 */
export function decisionErrorCode(err: unknown): DecisionErrorCode | null {
  if (!(err instanceof LumiError)) return null;
  const code: unknown = (err.body as LumiErrorBody | undefined)?.errors?.[0]?.code;
  return typeof code === "string" && KNOWN_CODES.has(code) ? (code as DecisionErrorCode) : null;
}

export interface DecideOptions {
  /**
   * Aborts the HTTP request; the promise rejects with the fetch `AbortError`.
   * The CMS sees the disconnect, aborts its upstream call and does not retry.
   */
  signal?: AbortSignal;
}

/**
 * Ask the decision model typed questions about `state`. Read-only on the
 * server. Rejects with `LumiError` on non-2xx — e.g. 503 with
 * `DECISION_NOT_CONFIGURED` when the CMS has no `DECISION_PROVIDER`.
 *
 * The caller needs the `ai:decide` capability (403 `FORBIDDEN`), the site
 * must have opted in (403 `DECISION_DISABLED`), and each site has hourly,
 * concurrency and daily budgets (429 `DECISION_QUOTA_EXCEEDED` /
 * `DECISION_CONCURRENCY_LIMITED`, with `Retry-After`).
 */
export function decide(request: DecisionRequest, options: DecideOptions = {}) {
  return async (client: LumiClient): Promise<DecisionResult> => {
    const res = await client.rawRequest<DecisionResult>("/api/v1/ai/decisions", {
      method: "POST",
      body: JSON.stringify(request),
      signal: options.signal,
    });
    return res.data;
  };
}
