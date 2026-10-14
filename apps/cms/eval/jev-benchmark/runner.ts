/**
 * Runs one provider over a set of samples and records, per sample, the
 * answer or the failure code plus the wall-clock latency of the call.
 */

import {
  DecisionProviderError,
  type DecisionProvider,
  type DecisionQuestion,
  type DecisionResponse,
} from '../../src/services/decision-provider';
import type { BenchmarkSample, Locale, Split } from './dataset';
import type { CallRecord, ChoiceObservation, NoulObservation } from './metrics';
import { requestFor } from './rubric';

export interface SampleResult {
  id: string;
  locale: Locale;
  split: Split;
  tags: string[];
  labels: Record<string, string | boolean>;
  latencyMs: number;
  /** Decision error code (`DECISION_TIMEOUT`, …), `INTERNAL` for anything else, null on success. */
  error: string | null;
  response: DecisionResponse | null;
}

export interface RunOptions {
  /** Parallel calls. Keep it low against real providers: rate limits count as failures. */
  concurrency?: number;
  now?: () => number;
}

export async function runSamples(
  provider: DecisionProvider,
  samples: readonly BenchmarkSample[],
  questions: Record<string, DecisionQuestion>,
  options: RunOptions = {},
): Promise<SampleResult[]> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const now = options.now ?? (() => performance.now());
  const results = new Array<SampleResult>(samples.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= samples.length) return;
      const sample = samples[index]!;
      const started = now();
      let response: DecisionResponse | null = null;
      let error: string | null = null;
      try {
        response = await provider.decide(requestFor(sample, questions));
      } catch (err) {
        error = err instanceof DecisionProviderError ? err.code : 'INTERNAL';
      }
      results[index] = {
        id: sample.id,
        locale: sample.locale,
        split: sample.split,
        tags: [...sample.tags],
        labels: { ...sample.labels },
        latencyMs: Math.max(0, now() - started),
        error,
        response,
      };
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, samples.length) }, worker));
  return results;
}

export function callRecords(results: readonly SampleResult[]): CallRecord[] {
  return results.map((r) => ({ latencyMs: r.latencyMs, error: r.error, usage: r.response?.usage ?? null }));
}

export function choiceObservations(results: readonly SampleResult[], question: string): ChoiceObservation[] {
  return results.map((r) => {
    const answer = r.response?.answers[question];
    return {
      gold: String(r.labels[question]),
      answer: answer && answer.type === 'choice'
        ? { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities }
        : null,
    };
  });
}

export function noulObservations(results: readonly SampleResult[], question: string): NoulObservation[] {
  return results.map((r) => {
    const answer = r.response?.answers[question];
    return { gold: r.labels[question] === true, p: answer && answer.type === 'noul' ? answer.noul : null };
  });
}
