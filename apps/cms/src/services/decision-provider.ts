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
 *   - `llm`        — equivalent fallback on top of the configured LLM_PROVIDER.
 *                    Its probabilities come from the LLM itself and are NOT
 *                    calibrated (`calibrated: false` on every response).
 *
 * Configuration:
 *   DECISION_PROVIDER = 'typesafe' | 'openrouter' | 'llm'   (unset → disabled)
 *   DECISION_MODEL    — optional model override
 *   TYPESAFE_API_KEY  — required when DECISION_PROVIDER = 'typesafe'
 *   TYPESAFE_BASE_URL — optional TypeSafe endpoint override
 *   OPENROUTER_API_KEY — required when DECISION_PROVIDER = 'openrouter'
 */

import { createConfiguredLLMProvider, type LLMProvider, type LLMProviderEnv } from './llm-provider';
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
  usage: { inputTokens: number; outputTokens: number };
}

export interface DecisionProvider {
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

export type DecisionErrorCode =
  | 'DECISION_AUTH'
  | 'DECISION_VALIDATION'
  | 'DECISION_RATE_LIMITED'
  | 'DECISION_UNAVAILABLE'
  | 'DECISION_UPSTREAM'
  | 'DECISION_PARSE_FAILED';

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

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
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

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  /** Retries after the first attempt on 429/529/503. */
  maxRetries?: number;
  /** Base backoff in ms; doubles per retry. */
  retryBaseMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
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
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SystemOneProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'jev-latest';
    this.baseUrl = (options.baseUrl ?? 'https://api.typesafe.ai/v1').replace(/\/+$/, '');
    this.name = options.name ?? 'typesafe';
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const body = JSON.stringify({
      model: this.model,
      state: request.state,
      questions: request.questions,
    });

    let res: Response | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      res = await fetch(`${this.baseUrl}/systemone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
      });
      if (!isRetryableStatus(res.status) || attempt === this.maxRetries) break;
      await this.sleep(this.retryBaseMs * 2 ** attempt);
    }

    if (!res || !res.ok) {
      const status = res?.status ?? 0;
      const detail = res ? (await res.text().catch(() => '')).slice(0, 500) : '';
      throw new DecisionProviderError(
        errorCodeForStatus(status),
        `${this.name} decision API error ${status}${detail ? `: ${detail}` : ''}`,
        status,
      );
    }

    const data: unknown = await res.json().catch(() => null);
    if (!isRecord(data)) {
      throw new DecisionProviderError('DECISION_PARSE_FAILED', `${this.name} returned a non-JSON body.`);
    }
    const usage = isRecord(data.usage) ? data.usage : {};

    return {
      provider: this.name,
      model: typeof data.model === 'string' ? data.model : this.model,
      calibrated: true,
      answers: normalizeAnswers(request, data.answers),
      usage: {
        inputTokens: toNumber(usage.input_tokens),
        outputTokens: toNumber(usage.output_tokens),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// LLM fallback (equivalent AI, uncalibrated)
// ---------------------------------------------------------------------------

const LLM_DECISION_PROMPT = `You are a structured decision engine. You never write prose.
You receive application STATE and a JSON map of typed QUESTIONS. Answer every question.
Reply with ONLY a JSON object of the form {"answers": {"<question key>": <answer>}} where:
- noul   → {"noul": <probability the "true" criterion holds, 0..1>}
- choice → {"choice": "<one option key>", "probabilities": {"<option key>": 0..1, ...}, "confidence": 0..1}
- score  → {"score": <0-based index of the best rubric level>, "probabilities": {"<level index>": 0..1, ...}, "confidence": 0..1}
Probabilities in each answer must sum to 1. Do not call tools.`;

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

  constructor(llm: LLMProvider, model: string) {
    this.llm = llm;
    this.model = model;
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const response = await this.llm.chat([
      { role: 'system', content: LLM_DECISION_PROMPT },
      {
        role: 'user',
        content: `STATE:\n${JSON.stringify(request.state)}\n\nQUESTIONS:\n${JSON.stringify(request.questions)}`,
      },
    ]);

    const parsed = response.content ? extractJsonObject(response.content) : null;
    if (!isRecord(parsed)) {
      throw new DecisionProviderError('DECISION_PARSE_FAILED', 'LLM did not return a JSON object.');
    }

    // The LLM prompt omits type/legend. Supply only those structural fields;
    // numeric answers and probabilities must pass the same validation as Jev.
    const rawAnswers = isRecord(parsed.answers) ? parsed.answers : {};
    const prepared = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
      const raw = Object.hasOwn(rawAnswers, key) ? rawAnswers[key] : undefined;
      if (!isRecord(raw)) return [key, raw];
      return [key, {
        type: question.type,
        ...(question.type === 'score'
          ? { legend: Object.fromEntries(question.criteria.map((level, i) => [String(i), level])) }
          : {}),
        ...raw,
      }];
    }));
    const answers = normalizeAnswers(request, prepared);
    // Rubric levels are positional; mirror them in `legend` like Jev does.
    for (const [key, answer] of Object.entries(answers)) {
      const question = request.questions[key];
      if (answer.type === 'score' && question?.type === 'score') {
        answer.score = Math.round(answer.score);
        answer.legend = Object.fromEntries(question.criteria.map((level, i) => [String(i), level]));
      }
    }

    return {
      provider: 'llm',
      model: this.model,
      calibrated: false,
      answers,
      usage: { inputTokens: 0, outputTokens: 0 },
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
}

export interface ConfiguredDecisionProvider {
  provider: DecisionProvider;
  /** Provider name from DECISION_PROVIDER. */
  name: string;
  /** Resolved model identifier. */
  model: string;
}

/**
 * Resolves the decision provider from the environment, or `null` when none is
 * configured. There is deliberately no stub fallback: a fabricated decision is
 * worse than a loud DECISION_NOT_CONFIGURED.
 */
export function createDecisionProvider(env: DecisionProviderEnv): ConfiguredDecisionProvider | null {
  const name = env.DECISION_PROVIDER;

  switch (name) {
    case 'typesafe': {
      if (!env.TYPESAFE_API_KEY) return null;
      const model = env.DECISION_MODEL || 'jev-latest';
      return {
        name,
        model,
        provider: new SystemOneDecisionProvider({
          apiKey: env.TYPESAFE_API_KEY,
          model,
          baseUrl: env.TYPESAFE_BASE_URL || undefined,
          name,
        }),
      };
    }

    case 'openrouter': {
      if (!env.OPENROUTER_API_KEY) return null;
      const model = env.DECISION_MODEL || '~typesafe/jev-latest';
      return {
        name,
        model,
        provider: new SystemOneDecisionProvider({
          apiKey: env.OPENROUTER_API_KEY,
          model,
          baseUrl: 'https://openrouter.ai/api/v1',
          name,
        }),
      };
    }

    case 'llm': {
      const llm = createConfiguredLLMProvider(env);
      if (!llm) return null;
      const model = `${llm.name}:${llm.model}`;
      return { name, model, provider: new LLMDecisionProvider(llm.provider, model) };
    }

    default:
      return null;
  }
}
