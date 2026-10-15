/**
 * Builds the benchmark's Decision questions from the J05 review presets, so
 * the benchmark measures the rubric the product ships, not a tuned copy.
 *
 * The questions are frozen by `manifest.profile.rubricVersion`. Editing a
 * preset changes the version, the loader refuses the dataset, and the next
 * benchmark has to be a new protocol version: results from two rubrics are
 * not comparable.
 */

import { createHash } from 'node:crypto';
import type { ReviewPresetOptions } from '@lumibase/contracts/schemas';
import type { DecisionQuestion, DecisionRequest } from '../../src/services/decision-provider';
import { buildPresetProfile } from '../../src/services/review-presets';
import type { BenchmarkSample, DatasetManifest } from './dataset';

export function buildBenchmarkQuestions(manifest: DatasetManifest): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};
  for (const entry of manifest.profile.presets) {
    const profile = buildPresetProfile({ preset: entry.preset, options: entry.options as ReviewPresetOptions | undefined });
    for (const key of entry.questions) {
      const question = profile.questions[key];
      if (!question) throw new Error(`Preset "${entry.preset}" has no question "${key}"`);
      if (Object.hasOwn(questions, key)) throw new Error(`Question "${key}" is defined twice`);
      questions[key] = question as DecisionQuestion;
    }
  }
  for (const key of Object.keys(manifest.labelSchema)) {
    if (!Object.hasOwn(questions, key)) throw new Error(`Label "${key}" has no question in the profile`);
  }
  for (const [key, spec] of Object.entries(manifest.labelSchema)) {
    const question = questions[key]!;
    if (question.type !== spec.type) throw new Error(`Label "${key}" is ${spec.type}, question is ${question.type}`);
    if (spec.type === 'choice' && question.type === 'choice') {
      const options = Object.keys(question.criteria).sort().join(',');
      if (options !== [...spec.options].sort().join(',')) {
        throw new Error(`Label "${key}" options ${spec.options.join(', ')} differ from the question's ${options}`);
      }
    }
  }
  return questions;
}

/**
 * Same fingerprint as `decisionRubricVersion` in `decision-governance.ts`
 * (a parity test pins it), computed here so the CLI does not load the
 * governance module and its database dependencies.
 */
export function benchmarkRubricVersion(questions: Record<string, DecisionQuestion>): string {
  const digest = createHash('sha256').update(JSON.stringify(questions)).digest();
  return `sha256:${[...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Content goes only in `state`; the questions come from the presets. */
export function requestFor(sample: BenchmarkSample, questions: Record<string, DecisionQuestion>): DecisionRequest {
  return { state: { ...sample.fields }, questions };
}
