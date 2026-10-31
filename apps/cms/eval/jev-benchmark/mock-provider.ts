/**
 * Seeded mock decision provider for the benchmark harness.
 *
 * It answers from the GOLD LABELS with seeded noise, so its numbers say
 * nothing about Jev or any model. It exists to exercise the harness end to
 * end without keys: metrics, thresholds, failure accounting and reports.
 * Every report it feeds is written with `mode: "mock"`, and mock reports can
 * never be merged with live ones.
 */

import {
  DecisionProviderError,
  estimateDecisionTokens,
  type DecisionAnswer,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
} from '../../src/services/decision-provider';
import type { BenchmarkSample } from './dataset';

export const MOCK_PROVIDER = 'mock';
export const MOCK_MODEL = 'mock-oracle-v1';

/** FNV-1a 32-bit. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small deterministic PRNG in [0, 1). */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stateKey(state: unknown): string {
  return JSON.stringify(state);
}

export interface MockOptions {
  seed: number;
  /** Probability that an answer matches the gold label. */
  accuracy: number;
  /** Probability that a call fails (half timeouts, half unavailable). */
  failureRate: number;
  /** Samples whose labels the mock answers from, keyed by their `fields`. */
  samples: readonly BenchmarkSample[];
}

export class MockOracleProvider implements DecisionProvider {
  private readonly oracle = new Map<string, Record<string, string | boolean>>();

  constructor(private readonly options: MockOptions) {
    for (const sample of options.samples) this.oracle.set(stateKey(sample.fields), sample.labels);
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    const key = stateKey(request.state);
    const labels = this.oracle.get(key);
    if (!labels) throw new DecisionProviderError('DECISION_VALIDATION', 'Mock provider only answers benchmark samples.');
    const random = prng(hash32(`${this.options.seed}:${key}`));

    const draw = random();
    if (draw < this.options.failureRate) {
      throw draw < this.options.failureRate / 2
        ? new DecisionProviderError('DECISION_TIMEOUT', 'Mock timeout.')
        : new DecisionProviderError('DECISION_UNAVAILABLE', 'Mock outage.');
    }

    const answers: Record<string, DecisionAnswer> = {};
    for (const [name, question] of Object.entries(request.questions)) {
      const correct = random() < this.options.accuracy;
      if (question.type === 'noul') {
        const gold = labels[name] === true;
        const lean = correct ? 0.6 + 0.4 * random() : 0.05 + 0.4 * random();
        answers[name] = { type: 'noul', noul: gold ? lean : 1 - lean };
      } else if (question.type === 'choice') {
        const options = Object.keys(question.criteria);
        const gold = String(labels[name]);
        const others = options.filter((o) => o !== gold);
        const choice = correct || others.length === 0 ? gold : others[Math.floor(random() * others.length)]!;
        const confidence = correct ? 0.55 + 0.45 * random() : 0.3 + 0.5 * random();
        const rest = options.length > 1 ? (1 - confidence) / (options.length - 1) : 0;
        const probabilities = Object.fromEntries(options.map((o) => [o, o === choice ? confidence : rest]));
        answers[name] = { type: 'choice', choice, confidence, probabilities };
      } else {
        // Not labelled in v1: a uniform distribution, so the shape stays valid.
        const levels = question.criteria.map((_, i) => String(i));
        const p = 1 / levels.length;
        answers[name] = {
          type: 'score',
          score: (levels.length - 1) / 2,
          legend: Object.fromEntries(levels.map((level, i) => [level, question.criteria[i]])),
          probabilities: Object.fromEntries(levels.map((level) => [level, p])),
          confidence: p,
        };
      }
    }

    return {
      provider: MOCK_PROVIDER,
      model: MOCK_MODEL,
      calibrated: false,
      answers,
      // Input estimated like the real budget check; output deliberately unknown.
      usage: { inputTokens: estimateDecisionTokens(JSON.stringify(request)), outputTokens: null },
    };
  }
}
