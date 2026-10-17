/**
 * Decision Provider abstraction — typed, probabilistic decisions.
 *
 * Distinct from `llm-provider.ts`: a decision model does not generate text or
 * call tools. It receives application `state` plus a map of typed questions and
 * returns one typed answer per question:
 *
 *   - `noul`   — yes/no, answered as P(true) in [0, 1]
 *   - `choice` — categorical, answered as the winning option key + probabilities
 *   - `score`  — ordinal rubric (2–10 levels), answered as a score + probabilities
 *
 * Providers:
 *   - `typesafe`   — TypeSafe Jev via `POST {base}/systemone` (TYPESAFE_API_KEY)
 *   - `openrouter` — the same System One surface proxied by OpenRouter
 *                    (OPENROUTER_API_KEY), billed to the OpenRouter account
 *   - `llm`        — equivalent provider on top of the configured LLM_PROVIDER,
 *                    selected explicitly by configuration. It is NOT an
 *                    automatic failover: nothing switches to it when Jev
 *                    fails. Its probabilities come from the LLM itself and are
 *                    NOT calibrated (`calibrated: false` on every response),
 *                    so thresholds tuned for Jev do not transfer to it.
 *
 * Configuration:
 *   DECISION_PROVIDER = 'typesafe' | 'openrouter' | 'llm'   (unset → disabled)
 *   DECISION_MODEL    — optional model override
 *   TYPESAFE_API_KEY  — required when DECISION_PROVIDER = 'typesafe'
 *   TYPESAFE_BASE_URL — optional TypeSafe endpoint override
 *   OPENROUTER_API_KEY — required when DECISION_PROVIDER = 'openrouter'
 *
 * Bounds (all optional, see DEFAULT_DECISION_LIMITS):
 *   DECISION_TIMEOUT_MS         — total deadline per decision, retries included
 *   DECISION_ATTEMPT_TIMEOUT_MS — timeout of one upstream attempt
 *   DECISION_MAX_RETRIES        — retries after the first attempt (0–5)
 *   DECISION_MAX_INPUT_BYTES    — UTF-8 byte cap on the serialized state + questions
 *   DECISION_MAX_INPUT_TOKENS   — estimated token budget for the same payload
 */

import {
  createConfiguredLLMProvider,
  LLMHttpError,
  LLMNetworkError,
  LLMResponseError,
  type LLMProvider,
  type LLMProviderEnv,
  type LLMResponse,
} from './llm-provider';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Free-form payload accepted by the System One API: text or structured data. */
export type DecisionPayload = string | Record<string, unknown> | unknown[];

export interface NoulQuestion {
  type: 'noul';
  instructions: DecisionPayload;
  criteria: { true: DecisionPayload; false: DecisionPayload };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: DecisionPayload;
  /** Option key → description (or `null` when the key is self-explanatory). */
  criteria: Record<string, DecisionPayload | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: DecisionPayload;
  /** Ordered rubric levels, lowest first. */
  criteria: DecisionPayload[];
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface DecisionRequest {
  state: DecisionPayload;
  questions: Record<string, DecisionQuestion>;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionResponse {
  /** Provider name (`typesafe`, `openrouter`, `llm`). */
  provider: string;
  /** Model identifier reported by the upstream (or the configured one). */
  model: string;
  /** Whether probabilities come from a calibrated decision model. */
  calibrated: boolean;
  answers: Record<string, DecisionAnswer>;
  /** `null` when the provider did not report the count (unknown, not zero). */
  usage: { inputTokens: number | null; outputTokens: number | null };
}

export interface DecisionCallOptions {
  /** Cancels the decision; no retry is attempted after it aborts. */
  signal?: AbortSignal;
  /**
   * Called right before each upstream request is sent, retries included, so
   * a caller can account for attempts that failed or timed out. Not called
   * for a request rejected locally (cancelled, over the input or output
   * budget). Must not throw; a throwing hook is swallowed with a warning.
   */
  onAttempt?: () => void;
}

export interface DecisionProvider {
  decide(request: DecisionRequest, options?: DecisionCallOptions): Promise<DecisionResponse>;
}

export interface DecisionLimits {
  /** Total wall-clock budget for one decision, retries and backoff included. */
  deadlineMs: number;
  /** Timeout of a single upstream attempt (capped by what remains of the deadline). */
  attemptTimeoutMs: number;
  /** Retries after the first attempt, for 429/503/529, network errors and attempt timeouts. */
  maxRetries: number;
  /** Hard cap on the UTF-8 size of the serialized `{ state, questions }`. */
  maxInputBytes: number;
  /** Cap on the estimated token count of the same payload (see estimateDecisionTokens). */
  maxInputTokens: number;
  /**
   * `llm` only: cap on the estimated answer size (estimateDecisionAnswerTokens).
   * Same on every provider; Gemini/Vertex thinking headroom is added after it.
   */
  maxOutputTokens: number;
}

/**
 * Jev's context window is 32,000 tokens (OpenRouter model card). The token
 * budget keeps 25% headroom for the provider's own framing because the count
 * below is an estimate, not Jev's tokenizer.
 */
export const DEFAULT_DECISION_LIMITS: DecisionLimits = {
  deadlineMs: 20_000,
  attemptTimeoutMs: 8_000,
  maxRetries: 2,
  maxInputBytes: 131_072,
  maxInputTokens: 24_000,
  maxOutputTokens: 4_096,
};

export type DecisionErrorCode =
  | 'DECISION_AUTH'
  | 'DECISION_VALIDATION'
  | 'DECISION_RATE_LIMITED'
  | 'DECISION_UNAVAILABLE'
  | 'DECISION_UPSTREAM'
  | 'DECISION_PARSE_FAILED'
  | 'DECISION_TIMEOUT'
  | 'DECISION_CANCELLED'
  | 'DECISION_INPUT_TOO_LARGE';

export class DecisionProviderError extends Error {
  readonly code: DecisionErrorCode;
  /** Upstream HTTP status, when the error came from an HTTP response. */
  readonly status?: number;

  constructor(code: DecisionErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'DecisionProviderError';
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Expected rubric level Σ i·p(i) on the 0..N-1 scale, the same weighted score
 * Jev reports. Used for the LLM provider so one distribution yields one score
 * whichever adapter produced it.
 */
export function weightedScore(probabilities: Record<string, number>, levels: number): number {
  let score = 0;
  for (let i = 0; i < levels; i += 1) score += i * (probabilities[String(i)] ?? 0);
  // Rounding noise must not push the result outside the declared scale.
  return Math.min(levels - 1, Math.max(0, score));
}

// Permit ordinary decimal serialization error, never repair a broken distribution.
const PROBABILITY_SUM_TOLERANCE = 1e-6;
const probabilitySchema = z.number().min(0).max(1);
const probabilitiesSchema = z.record(z.string(), probabilitySchema);
const answerSchemas = {
  noul: z.object({ type: z.literal('noul'), noul: probabilitySchema }),
  choice: z.object({
    type: z.literal('choice'), choice: z.string(),
    probabilities: probabilitiesSchema, confidence: probabilitySchema,
  }),
  score: z.object({
    type: z.literal('score'), score: z.number().min(0),
    legend: z.record(z.string(), z.unknown()),
    probabilities: probabilitiesSchema, confidence: probabilitySchema,
  }),
};

function unusableAnswer(): never {
  throw new DecisionProviderError('DECISION_PARSE_FAILED', 'The decision answer violates its question contract.');
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateProbabilities(probabilities: Record<string, number>, keys: string[]): void {
  if (!hasExactKeys(probabilities, keys)) unusableAnswer();
  const sum = Object.values(probabilities).reduce((total, probability) => total + probability, 0);
  // Allow machine addition error at the tolerance boundary itself.
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE + Number.EPSILON * keys.length) unusableAnswer();
}

function errorCodeForStatus(status: number): DecisionErrorCode {
  if (status === 401 || status === 403) return 'DECISION_AUTH';
  if (status === 400 || status === 422) return 'DECISION_VALIDATION';
  if (status === 429) return 'DECISION_RATE_LIMITED';
  if (status === 529 || status === 502 || status === 503 || status === 504) {
    return 'DECISION_UNAVAILABLE';
  }
  return 'DECISION_UPSTREAM';
}

/** 429 (rate limit) and 529 (overloaded) are retryable per the TypeSafe API docs. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529 || status === 503;
}

/**
 * Normalises one upstream answer to the typed shape, keyed by the question's
 * declared type so a malformed upstream answer cannot change the contract.
 */
function normalizeAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer {
  // Zod object fields can be read from the prototype; require own fields first.
  if (!isRecord(raw)) unusableAnswer();
  const schema = answerSchemas[question.type];
  if (!Object.keys(schema.shape).every((key) => Object.hasOwn(raw, key))) unusableAnswer();
  if (question.type !== 'noul') {
    const keys = question.type === 'choice'
      ? Object.keys(question.criteria)
      : question.criteria.map((_, i) => String(i));
    if (!isRecord(raw.probabilities) || !hasExactKeys(raw.probabilities, keys)) unusableAnswer();
    if (question.type === 'score' && (!isRecord(raw.legend) || !hasExactKeys(raw.legend, keys))) unusableAnswer();
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) unusableAnswer();
  const answer = parsed.data;

  switch (answer.type) {
    case 'noul':
      return answer;

    case 'choice': {
      if (question.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice)) unusableAnswer();
      validateProbabilities(answer.probabilities, Object.keys(question.criteria));
      return answer;
    }

    case 'score': {
      if (question.type !== 'score' || answer.score > question.criteria.length - 1) unusableAnswer();
      const levels = question.criteria.map((_, i) => String(i));
      validateProbabilities(answer.probabilities, levels);
      if (!hasExactKeys(answer.legend, levels)) unusableAnswer();
      return answer;
    }
  }
}

function normalizeAnswers(
  request: DecisionRequest,
  rawAnswers: unknown,
): Record<string, DecisionAnswer> {
  const answers = isRecord(rawAnswers) ? rawAnswers : {};
  return Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
    if (!Object.hasOwn(answers, key)) {
      throw new DecisionProviderError('DECISION_PARSE_FAILED', `Missing answer for "${key}".`);
    }
    return [key, normalizeAnswer(question, answers[key])];
  }));
}

// ---------------------------------------------------------------------------
// Input budget
// ---------------------------------------------------------------------------

export interface DecisionInputSize {
  bytes: number;
  estimatedTokens: number;
}

/**
 * Conservative token estimate without a tokenizer: ~4 ASCII characters per
 * token, and every non-ASCII code point counted as a whole token. Vietnamese
 * diacritics are mostly non-ASCII, so VI text is budgeted far more tightly
 * than EN text of the same length. It over-counts rather than under-counts
 * for the scripts LumiBase serves; it is not Jev's tokenizer.
 */
export function estimateDecisionTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}

/** Measures everything sent upstream: state, instructions, criteria and nesting. */
export function measureDecisionInput(request: DecisionRequest): DecisionInputSize {
  const text = JSON.stringify({ state: request.state, questions: request.questions });
  return {
    bytes: new TextEncoder().encode(text).length,
    estimatedTokens: estimateDecisionTokens(text),
  };
}

export function assertDecisionInputBudget(request: DecisionRequest, limits: DecisionLimits): DecisionInputSize {
  const size = measureDecisionInput(request);
  if (size.bytes > limits.maxInputBytes) {
    throw new DecisionProviderError(
      'DECISION_INPUT_TOO_LARGE',
      `Decision input is ${size.bytes} bytes; the limit is ${limits.maxInputBytes}.`,
    );
  }
  if (size.estimatedTokens > limits.maxInputTokens) {
    throw new DecisionProviderError(
      'DECISION_INPUT_TOO_LARGE',
      `Decision input is ~${size.estimatedTokens} tokens (estimated); the limit is ${limits.maxInputTokens}.`,
    );
  }
  return size;
}

// ---------------------------------------------------------------------------
// Output budget
// ---------------------------------------------------------------------------

/** Placeholder for every probability/confidence in the worst-case answer skeleton. */
const SKELETON_PROBABILITY = 0.123456;

/** Floor of the output cap sent upstream: a tiny request still leaves room for fences/whitespace. */
const DECISION_MIN_OUTPUT_TOKENS = 256;

function tokenWeight(text: string): { ascii: number; other: number } {
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 0x80) ascii += 1;
    else other += 1;
  }
  return { ascii, other };
}

/** Longest option key by token weight; ties broken lexicographically so key order never matters. */
function heaviestKey(keys: string[]): string {
  let best = '';
  let bestWeight = -1;
  for (const key of keys) {
    const { ascii, other } = tokenWeight(key);
    const weight = ascii / 2 + other;
    if (weight > bestWeight || (weight === bestWeight && key > best)) {
      best = key;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * Estimates the output tokens of a complete decision answer, without a
 * tokenizer. It serializes the worst-case answer skeleton the decision prompt
 * asks for — real question and option keys, every probability as `0.123456`,
 * the heaviest option as `choice` — then counts ~2 ASCII characters per token
 * (JSON is punctuation- and digit-dense), one token per non-ASCII code point,
 * ×1.25 safety margin and +32 for whitespace/fences. Deterministic and
 * independent of key order; it over-counts rather than under-counts.
 */
export function estimateDecisionAnswerTokens(questions: DecisionRequest['questions']): number {
  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (question.type === 'noul') {
      answers[key] = { noul: SKELETON_PROBABILITY };
      continue;
    }
    const options = question.type === 'choice'
      ? Object.keys(question.criteria)
      : question.criteria.map((_, i) => String(i));
    const probabilities = Object.fromEntries(options.map((option) => [option, SKELETON_PROBABILITY]));
    answers[key] = question.type === 'choice'
      ? { choice: heaviestKey(options), probabilities, confidence: SKELETON_PROBABILITY }
      : { probabilities, confidence: SKELETON_PROBABILITY };
  }
  const { ascii, other } = tokenWeight(JSON.stringify({ answers }));
  return Math.ceil(1.25 * (Math.ceil(ascii / 2) + other)) + 32;
}

/**
 * `llm` output cap for one request. The estimated answer size alone is
 * compared with `limits.maxOutputTokens` (413 before any upstream call);
 * Gemini/Vertex thinking headroom is added only to the value sent upstream.
 * Returns that value: `max(need, 256) + thinkingTokens`.
 */
export function assertDecisionOutputBudget(
  request: DecisionRequest,
  limits: DecisionLimits,
  thinkingTokens: number,
): number {
  const need = estimateDecisionAnswerTokens(request.questions);
  if (need > limits.maxOutputTokens) {
    throw new DecisionProviderError(
      'DECISION_INPUT_TOO_LARGE',
      `Decision answers need ~${need} output tokens (estimated); the limit is ${limits.maxOutputTokens}.`,
    );
  }
  return Math.max(need, DECISION_MIN_OUTPUT_TOKENS) + thinkingTokens;
}

/** Runs the caller's attempt hook; a throwing hook must never break a decision. */
function notifyAttempt(options: DecisionCallOptions): void {
  if (!options.onAttempt) return;
  try {
    options.onAttempt();
  } catch (error) {
    console.warn('[decision] onAttempt hook threw; ignored', error instanceof Error ? error.name : typeof error);
  }
}

// ---------------------------------------------------------------------------
// Deadline, cancellation and retry helpers
// ---------------------------------------------------------------------------

function cancelledError(): DecisionProviderError {
  return new DecisionProviderError('DECISION_CANCELLED', 'The decision request was cancelled.');
}

function timeoutError(deadlineMs: number): DecisionProviderError {
  return new DecisionProviderError('DECISION_TIMEOUT', `The decision did not complete within ${deadlineMs} ms.`);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

/** Sleeps `ms`, rejecting with DECISION_CANCELLED as soon as `signal` aborts. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** `Retry-After` as delta-seconds or an HTTP date, in ms from `now`; null when absent/invalid. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Races `work` against the deadline and the caller's signal. `work` itself is not cancelled. */
function withDeadline<T>(work: Promise<T>, deadlineMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(timeoutError(deadlineMs));
    }, deadlineMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

type AttemptOutcome =
  | { kind: 'ok'; data: unknown }
  | { kind: 'http'; status: number; text: string; retryAfterMs: number | null }
  | { kind: 'network' }
  | { kind: 'timeout' };

// ---------------------------------------------------------------------------
// TypeSafe System One (Jev)
// ---------------------------------------------------------------------------

export interface SystemOneProviderOptions {
  apiKey: string;
  model?: string;
  /** API root without a trailing slash. `/systemone` is appended per call. */
  baseUrl?: string;
  /** Provider name echoed in responses and error messages. */
  name?: string;
  /** Deadline, attempt timeout, retry count and input budget. */
  limits?: Partial<DecisionLimits>;
  /** @deprecated Use `limits.maxRetries`. */
  maxRetries?: number;
  /** Base backoff in ms; the cap doubles per retry and the delay is drawn below it (full jitter). */
  retryBaseMs?: number;
  /** Upper bound of a single backoff delay before `Retry-After` is applied. */
  maxRetryDelayMs?: number;
  /** Injectable for tests. Must reject with DECISION_CANCELLED when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable jitter source in [0, 1). */
  random?: () => number;
  /** Injectable clock. */
  now?: () => number;
}

/**
 * Calls the TypeSafe System One API (`POST /systemone`). OpenRouter exposes the
 * same surface at `https://openrouter.ai/api/v1/systemone`, so the OpenRouter
 * provider is this class with a different base URL, key and model id.
 */
export class SystemOneDecisionProvider implements DecisionProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly name: string;
  private readonly limits: DecisionLimits;
  private readonly retryBaseMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: SystemOneProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'jev-latest';
    this.baseUrl = (options.baseUrl ?? 'https://api.typesafe.ai/v1').replace(/\/+$/, '');
    this.name = options.name ?? 'typesafe';
    this.limits = {
      ...DEFAULT_DECISION_LIMITS,
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...options.limits,
    };
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 4_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  async decide(request: DecisionRequest, options: DecisionCallOptions = {}): Promise<DecisionResponse> {
    const { signal } = options;
    throwIfCancelled(signal);
    // Rejected before any fetch: the budget is a property of the request.
    assertDecisionInputBudget(request, this.limits);

    const body = JSON.stringify({
      model: this.model,
      state: request.state,
      questions: request.questions,
    });
    const deadlineAt = this.now() + this.limits.deadlineMs;

    for (let attempt = 0; ; attempt += 1) {
      const remaining = deadlineAt - this.now();
      if (remaining <= 0) throw timeoutError(this.limits.deadlineMs);

      throwIfCancelled(signal);
      notifyAttempt(options);
      const outcome = await this.attempt(body, Math.min(this.limits.attemptTimeoutMs, remaining), signal);
      if (outcome.kind === 'ok') return this.parse(request, outcome.data);

      const failure = this.failureFor(outcome);
      // Auth, validation and other non-transient statuses are final.
      const retryable = outcome.kind !== 'http' || isRetryableStatus(outcome.status);
      if (!retryable || attempt >= this.limits.maxRetries) throw failure;

      const cap = Math.min(this.maxRetryDelayMs, this.retryBaseMs * 2 ** attempt);
      const backoff = Math.floor(this.random() * cap);
      const retryAfter = outcome.kind === 'http' ? outcome.retryAfterMs : null;
      const delay = Math.max(backoff, retryAfter ?? 0);
      // A wait that would exhaust the deadline cannot produce an answer in time.
      if (this.now() + delay >= deadlineAt) throw failure;
      await this.sleep(delay, signal);
      throwIfCancelled(signal);
    }
  }

  /** One fetch, body read included, under its own timeout and the caller's signal. */
  private async attempt(body: string, timeoutMs: number, signal?: AbortSignal): Promise<AttemptOutcome> {
    throwIfCancelled(signal);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/systemone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        // A non-JSON body is a parse failure, not a transport one: never retried.
        return { kind: 'ok', data: await res.json().catch(() => null) };
      }
      const text = await res.text().catch(() => '');
      return {
        kind: 'http',
        status: res.status,
        text,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), this.now()),
      };
    } catch {
      if (signal?.aborted) throw cancelledError();
      return timedOut ? { kind: 'timeout' } : { kind: 'network' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private failureFor(outcome: Exclude<AttemptOutcome, { kind: 'ok' }>): DecisionProviderError {
    if (outcome.kind === 'timeout') return timeoutError(this.limits.deadlineMs);
    if (outcome.kind === 'network') {
      return new DecisionProviderError('DECISION_UNAVAILABLE', `${this.name} decision API is unreachable.`);
    }
    // The upstream body may echo the request (state, criteria): never carry it
    // into the message, which the route logs.
    return new DecisionProviderError(
      errorCodeForStatus(outcome.status),
      `${this.name} decision API error ${outcome.status}`,
      outcome.status,
    );
  }

  private parse(request: DecisionRequest, data: unknown): DecisionResponse {
    if (!isRecord(data)) {
      throw new DecisionProviderError(
        'DECISION_PARSE_FAILED',
        `${this.name} returned a non-JSON body.`,
      );
    }
    const usage = isRecord(data.usage) ? data.usage : {};
    const answers = normalizeAnswers(request, data.answers);
    this.warnOnScoreDrift(request, answers);

    return {
      provider: this.name,
      model: typeof data.model === 'string' ? data.model : this.model,
      calibrated: true,
      answers,
      usage: {
        inputTokens: toCount(usage.input_tokens),
        outputTokens: toCount(usage.output_tokens),
      },
    };
  }

  /**
   * Jev ↔ LLM consistency rests on Jev's score being Σ i·p(i) (unverified).
   * Detect drift without changing the returned score; logs only the shape.
   */
  private warnOnScoreDrift(request: DecisionRequest, answers: Record<string, DecisionAnswer>): void {
    if (scoreDriftWarned) return;
    for (const [key, answer] of Object.entries(answers)) {
      const question = request.questions[key];
      if (answer.type !== 'score' || question?.type !== 'score') continue;
      const levels = question.criteria.length;
      const delta = Math.abs(answer.score - weightedScore(answer.probabilities, levels));
      if (delta > SCORE_DRIFT_TOLERANCE) {
        scoreDriftWarned = true;
        console.warn('[decision] upstream score differs from Σ i·p(i)', { provider: this.name, levels, delta });
        return;
      }
    }
  }
}

const SCORE_DRIFT_TOLERANCE = 1e-6;
/** One warning per isolate: drift is a property of the upstream, not of a request. */
let scoreDriftWarned = false;

/** @internal Test-only: re-arm the once-per-isolate warnings. */
export function resetDecisionProviderWarningsForTests(): void {
  scoreDriftWarned = false;
}

// ---------------------------------------------------------------------------
// LLM fallback (equivalent AI, uncalibrated)
// ---------------------------------------------------------------------------

const LLM_DECISION_PROMPT = `You are a structured decision engine. You never write prose.
You receive application STATE and a JSON map of typed QUESTIONS. Answer every question.
Reply with ONLY a JSON object of the form {"answers": {"<question key>": <answer>}} where:
- noul   → {"noul": <probability the "true" criterion holds, 0..1>}
- choice → {"choice": "<one option key>", "probabilities": {"<option key>": 0..1, ...}, "confidence": 0..1}
- score  → {"probabilities": {"<0-based level index>": 0..1, ...}, "confidence": 0..1}
Include every option key / level index in "probabilities"; each set must sum to 1.
Do not call tools. Do not add any text outside the JSON object.`;

/**
 * Maps an adapter failure to the same codes Jev uses for the same upstream
 * condition. Classification comes from the adapter (where the error
 * happened), never from JS error types: a malformed 2xx body also throws a
 * TypeError. Messages are fixed — the adapter's message carries the upstream
 * body, which may echo the request.
 */
function llmFailure(error: unknown): DecisionProviderError {
  if (error instanceof DecisionProviderError) return error;
  if (error instanceof LLMHttpError) {
    return new DecisionProviderError(errorCodeForStatus(error.status), `LLM provider error ${error.status}.`, error.status);
  }
  if (error instanceof LLMNetworkError) {
    return new DecisionProviderError('DECISION_UNAVAILABLE', 'LLM provider is unreachable.');
  }
  if (error instanceof LLMResponseError) {
    return new DecisionProviderError('DECISION_PARSE_FAILED', 'LLM provider returned an unusable response.');
  }
  return new DecisionProviderError('DECISION_UPSTREAM', 'LLM provider request failed.');
}

function extractJsonObject(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? content;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Answers decision questions with a general-purpose LLM. Useful when no Jev key
 * is available; the answers keep the same typed shape, but probabilities are
 * self-reported by the LLM and flagged `calibrated: false`.
 */
export class LLMDecisionProvider implements DecisionProvider {
  private readonly llm: LLMProvider;
  private readonly model: string;
  private readonly limits: DecisionLimits;
  /** Extra output headroom for models that count thinking inside the output cap (Gemini/Vertex). */
  private readonly thinkingTokens: number;

  constructor(llm: LLMProvider, model: string, limits: Partial<DecisionLimits> = {}, thinkingTokens = 0) {
    this.llm = llm;
    this.model = model;
    this.limits = { ...DEFAULT_DECISION_LIMITS, ...limits };
    this.thinkingTokens = thinkingTokens;
  }

  /** The output cap this provider sends for `request` (413 when the answer cannot fit). */
  outputCap(request: DecisionRequest): number {
    return assertDecisionOutputBudget(request, this.limits, this.thinkingTokens);
  }

  /**
   * One LLM call in structured decision mode (decision system prompt, no
   * CORE_SKILLS, no tool calling), bounded by the deadline. The deadline and
   * the caller's signal abort the adapter's HTTP request; the race below
   * still releases the caller if a custom LLMProvider ignores the signal.
   * Not retried: retries belong to the LLM provider layer.
   */
  async decide(request: DecisionRequest, options: DecisionCallOptions = {}): Promise<DecisionResponse> {
    throwIfCancelled(options.signal);
    assertDecisionInputBudget(request, this.limits);
    // Before the attempt hook and the fetch: an answer that cannot fit is a 413, not a truncated 502.
    const maxOutputTokens = this.outputCap(request);
    notifyAttempt(options);

    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, this.limits.deadlineMs);
    let response: LLMResponse;
    try {
      response = await withDeadline(
        this.llm.chat(
          [
            {
              role: 'user',
              content: `STATE:\n${JSON.stringify(request.state)}\n\nQUESTIONS:\n${JSON.stringify(request.questions)}`,
            },
          ],
          { systemPrompt: LLM_DECISION_PROMPT, tools: false, signal: controller.signal, maxOutputTokens },
        ),
        this.limits.deadlineMs,
        options.signal,
      );
    } catch (error) {
      // Our own abort surfaces from the adapter as a raw AbortError: map it.
      if (options.signal?.aborted) throw cancelledError();
      if (controller.signal.aborted) throw timeoutError(this.limits.deadlineMs);
      throw llmFailure(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }

    // A tool-only reply (no text) cannot carry decision JSON.
    if (response.toolCalls.length > 0 && !response.content) {
      throw new DecisionProviderError('DECISION_PARSE_FAILED', 'LLM answered with tool calls instead of decision JSON.');
    }

    const parsed = response.content ? extractJsonObject(response.content) : null;
    if (!isRecord(parsed)) {
      throw new DecisionProviderError('DECISION_PARSE_FAILED', 'LLM did not return a JSON object.');
    }

    // The LLM prompt omits type/legend/score. Supply only those structural
    // fields; probabilities and confidence pass the same validation as Jev.
    const rawAnswers = isRecord(parsed.answers) ? parsed.answers : {};
    const prepared = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
      const raw = Object.hasOwn(rawAnswers, key) ? rawAnswers[key] : undefined;
      if (!isRecord(raw)) return [key, raw];
      if (question.type !== 'score') return [key, { ...raw, type: question.type }];
      // The score is derived, never taken from the model: an LLM-picked level
      // would not match Jev's weighted score for the same distribution.
      const { score: _ignored, ...rest } = raw;
      const probabilities = isRecord(rest.probabilities) ? rest.probabilities : null;
      const finite = probabilities !== null
        && Object.values(probabilities).every((p) => typeof p === 'number' && Number.isFinite(p));
      return [key, {
        ...rest,
        type: 'score',
        legend: Object.fromEntries(question.criteria.map((level, i) => [String(i), level])),
        // Left out when the distribution is unusable, so validation rejects it.
        ...(finite ? { score: weightedScore(probabilities as Record<string, number>, question.criteria.length) } : {}),
      }];
    }));

    return {
      provider: 'llm',
      model: this.model,
      calibrated: false,
      answers: normalizeAnswers(request, prepared),
      usage: {
        inputTokens: response.usage?.inputTokens ?? null,
        outputTokens: response.usage?.outputTokens ?? null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface DecisionProviderEnv extends LLMProviderEnv {
  DECISION_PROVIDER?: string;
  DECISION_MODEL?: string;
  TYPESAFE_API_KEY?: string;
  TYPESAFE_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  DECISION_TIMEOUT_MS?: string;
  DECISION_ATTEMPT_TIMEOUT_MS?: string;
  DECISION_MAX_RETRIES?: string;
  DECISION_MAX_INPUT_BYTES?: string;
  DECISION_MAX_INPUT_TOKENS?: string;
  DECISION_LLM_MAX_OUTPUT_TOKENS?: string;
  DECISION_LLM_THINKING_TOKENS?: string;
}

/** Parses an integer env bound; invalid values fall back with a warning. */
export function readBound(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.warn(`[decision] ignoring ${name}=${raw}; expected an integer in ${min}..${max}`);
    return fallback;
  }
  return value;
}

/** Reads the DECISION_* bounds; invalid values fall back to the defaults with a warning. */
export function decisionLimitsFromEnv(env: DecisionProviderEnv): DecisionLimits {
  const d = DEFAULT_DECISION_LIMITS;
  return {
    deadlineMs: readBound(env.DECISION_TIMEOUT_MS, d.deadlineMs, 1_000, 120_000, 'DECISION_TIMEOUT_MS'),
    attemptTimeoutMs: readBound(
      env.DECISION_ATTEMPT_TIMEOUT_MS, d.attemptTimeoutMs, 500, 120_000, 'DECISION_ATTEMPT_TIMEOUT_MS',
    ),
    maxRetries: readBound(env.DECISION_MAX_RETRIES, d.maxRetries, 0, 5, 'DECISION_MAX_RETRIES'),
    maxInputBytes: readBound(env.DECISION_MAX_INPUT_BYTES, d.maxInputBytes, 1_024, 1_048_576, 'DECISION_MAX_INPUT_BYTES'),
    maxInputTokens: readBound(env.DECISION_MAX_INPUT_TOKENS, d.maxInputTokens, 256, 1_000_000, 'DECISION_MAX_INPUT_TOKENS'),
    maxOutputTokens: readBound(
      env.DECISION_LLM_MAX_OUTPUT_TOKENS, d.maxOutputTokens, 256, 32_768, 'DECISION_LLM_MAX_OUTPUT_TOKENS',
    ),
  };
}

/** Default Gemini/Vertex thinking headroom; uncalibrated until the J06 live smoke. */
export const DEFAULT_DECISION_THINKING_TOKENS = 1024;

/** LLM adapters whose models count thinking tokens inside the output cap. */
const THINKING_LLM_PROVIDERS = new Set(['gemini', 'vertex']);

export interface ConfiguredDecisionProvider {
  provider: DecisionProvider;
  /** Provider name from DECISION_PROVIDER. */
  name: string;
  /** Resolved model identifier. */
  model: string;
  /** Bounds the provider enforces; governance reserves quota against them. */
  limits: DecisionLimits;
  /**
   * `llm` only: output tokens one attempt of `request` may use, i.e. exactly
   * the cap sent upstream (thinking headroom included). Throws the same 413
   * (`DECISION_INPUT_TOO_LARGE`) when the answer cannot fit, so governance
   * can refuse before reserving quota. Undefined for Jev/OpenRouter, where
   * governance keeps its own estimate (`estimateDecisionOutputTokens` in decision-governance).
   */
  outputAllowance?(request: DecisionRequest): number;
}

/**
 * Resolves the decision provider from the environment, or `null` when none is
 * configured. There is deliberately no stub fallback: a fabricated decision is
 * worse than a loud DECISION_NOT_CONFIGURED.
 */
export function createDecisionProvider(
  env: DecisionProviderEnv,
): ConfiguredDecisionProvider | null {
  const name = env.DECISION_PROVIDER;
  const limits = decisionLimitsFromEnv(env);

  switch (name) {
    case 'typesafe': {
      if (!env.TYPESAFE_API_KEY) return null;
      const model = env.DECISION_MODEL || 'jev-latest';
      return {
        name,
        model,
        limits,
        provider: new SystemOneDecisionProvider({
          apiKey: env.TYPESAFE_API_KEY,
          model,
          baseUrl: env.TYPESAFE_BASE_URL || undefined,
          name,
          limits,
        }),
      };
    }

    case 'openrouter': {
      if (!env.OPENROUTER_API_KEY) return null;
      const model = env.DECISION_MODEL || '~typesafe/jev-latest';
      return {
        name,
        model,
        limits,
        provider: new SystemOneDecisionProvider({
          apiKey: env.OPENROUTER_API_KEY,
          model,
          baseUrl: 'https://openrouter.ai/api/v1',
          name,
          limits,
        }),
      };
    }

    case 'llm': {
      const llm = createConfiguredLLMProvider(env);
      if (!llm) return null;
      const model = `${llm.name}:${llm.model}`;
      const thinkingTokens = THINKING_LLM_PROVIDERS.has(llm.name)
        ? readBound(
          env.DECISION_LLM_THINKING_TOKENS, DEFAULT_DECISION_THINKING_TOKENS, 0, 32_768, 'DECISION_LLM_THINKING_TOKENS',
        )
        : 0;
      const provider = new LLMDecisionProvider(llm.provider, model, limits, thinkingTokens);
      return {
        name,
        model,
        limits,
        outputAllowance: (request) => provider.outputCap(request),
        provider,
      };
    }

    default:
      return null;
  }
}
