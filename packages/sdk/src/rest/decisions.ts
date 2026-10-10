/**
 * SDK command for the decision model endpoint (`POST /api/v1/ai/decisions`):
 * typed `noul` / `choice` / `score` questions answered with probabilities by
 * TypeSafe Jev or the configured equivalent. Command factory
 * `(client) => Promise<T>`, matching the rest of the REST module.
 *
 * Provider keys never reach the SDK: the CMS holds them and the client only
 * sends its usual bearer + `X-Lumi-Site` headers.
 */

import type { LumiClient } from "../client";

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
  usage: { inputTokens: number; outputTokens: number };
}

/** `errors[0].code` values `POST /ai/decisions` returns, carried on `LumiError.body`. */
export type DecisionErrorCode =
  | "VALIDATION"
  | "DECISION_NOT_CONFIGURED"
  | "DECISION_AUTH"
  | "DECISION_VALIDATION"
  | "DECISION_RATE_LIMITED"
  | "DECISION_UNAVAILABLE"
  | "DECISION_UPSTREAM"
  | "DECISION_PARSE_FAILED"
  | "DECISION_TIMEOUT"
  | "DECISION_CANCELLED"
  | "DECISION_INPUT_TOO_LARGE"
  | "INTERNAL";

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
