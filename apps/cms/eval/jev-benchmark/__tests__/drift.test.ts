import { describe, expect, it } from 'vitest';
import { semanticOutcome } from '../../../src/services/semantic-drift';
import { countBy, loadDataset } from '../dataset';
import {
  asRunnerSamples,
  driftLocaleMetrics,
  driftPrediction,
  driftQuestions,
  loadDriftDataset,
  runDriftBenchmark,
} from '../drift';
import { MockOracleProvider } from '../mock-provider';
import { MOCK_NOTE } from '../report';
import { benchmarkRubricVersion } from '../rubric';
import type { SampleResult } from '../runner';

/**
 * Semantic drift fixtures and scoring (J12, #519). The numbers a mock run
 * produces say nothing about any model; these tests pin the dataset, the
 * mapping and the metric math, not a result.
 */

const dataset = loadDriftDataset('v1');

function result(id: string, gold: boolean, noul: number | null, tags: string[] = ['true-drift'], error: string | null = null): SampleResult {
  return {
    id,
    locale: 'en',
    split: 'heldout',
    tags,
    labels: { off_brief: gold },
    latencyMs: 10,
    error,
    response:
      error !== null
        ? null
        : {
            provider: 'mock',
            model: 'm',
            calibrated: false,
            answers: noul === null ? {} : { off_brief: { type: 'noul', noul } },
            usage: { inputTokens: 1, outputTokens: null },
          },
  };
}

describe('drift fixtures', () => {
  it('load with verified hashes and the frozen rubric', () => {
    expect(dataset.samples).toHaveLength(40);
    expect(benchmarkRubricVersion(driftQuestions(dataset.manifest))).toBe(dataset.manifest.rubricVersion);
    expect(dataset.manifest.rule).toMatchObject({ contextSource: 'field:brief', threshold: 0.8 });
  });

  it('have VI and EN samples with true drift, false-positive traps, aligned and prompt-injection cases', () => {
    for (const locale of ['vi', 'en'] as const) {
      const samples = dataset.samples.filter((s) => s.locale === locale);
      expect(samples.length).toBeGreaterThanOrEqual(20);
      const tags = countBy(samples, (s) => s.tags[0]!);
      for (const tag of dataset.manifest.requiredTags) expect(tags[tag] ?? 0, `${locale}/${tag}`).toBeGreaterThan(0);
      expect(tags['true-drift']).toBeGreaterThanOrEqual(5);
      expect(tags['false-positive-trap']).toBeGreaterThanOrEqual(5);
      // Labels agree with the tags.
      for (const s of samples) {
        const expected = s.tags.includes('true-drift') || s.tags.includes('prompt-injection');
        expect(s.labels.drift, s.id).toBe(expected);
        expect(s.fields['brief']?.length ?? 0, s.id).toBeGreaterThan(0);
      }
    }
  });

  it('do not change the editorial dataset (its manifest still verifies)', () => {
    expect(() => loadDataset('v1')).not.toThrow();
  });
});

describe('drift scoring', () => {
  it('uses the production mapping; a failed call is unevaluated, never clean', () => {
    expect(driftPrediction(result('a', true, 0.9), 'off_brief', 0.8)).toBe(semanticOutcome(0.9, 0.8).kind);
    expect(driftPrediction(result('b', false, 0.1), 'off_brief', 0.8)).toBe('clean');
    expect(driftPrediction(result('c', true, 0.5), 'off_brief', 0.8)).toBe('unevaluated');
    expect(driftPrediction(result('d', true, null), 'off_brief', 0.8)).toBe('unevaluated');
    expect(driftPrediction(result('e', false, null, ['aligned'], 'DECISION_TIMEOUT'), 'off_brief', 0.8)).toBe('unevaluated');
  });

  it('computes precision, recall, coverage and the false-positive trap rate', () => {
    const metrics = driftLocaleMetrics(
      [
        result('1', true, 0.95), // TP
        result('2', true, 0.5), // unevaluated → missed
        result('3', false, 0.9, ['false-positive-trap']), // FP on a trap
        result('4', false, 0.05, ['false-positive-trap']), // TN
        result('5', true, 0.85, ['prompt-injection']), // TP
        result('6', false, null, ['aligned'], 'DECISION_UNAVAILABLE'), // failure
      ],
      'off_brief',
      0.8,
      null,
    );
    expect(metrics.outcomes).toEqual({ drift: 3, clean: 1, unevaluated: 2 });
    expect(metrics.precision).toMatchObject({ k: 2, n: 3 });
    expect(metrics.recall).toMatchObject({ k: 2, n: 3 });
    expect(metrics.coverage).toMatchObject({ k: 4, n: 6 });
    expect(metrics.falsePositiveTrapRate).toMatchObject({ k: 1, n: 2 });
    expect(metrics.injectionDetected).toMatchObject({ k: 1, n: 1 });
    expect(metrics.calls.failures).toMatchObject({ k: 1, n: 6 });
  });

  it('a mock run writes a report flagged as mock, per locale', async () => {
    const samples = asRunnerSamples(dataset.manifest, dataset.samples);
    const { report, results } = await runDriftBenchmark({
      dataset,
      provider: new MockOracleProvider({ seed: dataset.manifest.seed, accuracy: 0.8, failureRate: 0.05, samples }),
      providerName: 'mock',
      model: 'mock-oracle-v1',
      mode: 'mock',
      generatedAt: '2026-10-15T00:00:00.000Z',
    });
    expect(results).toHaveLength(40);
    expect(report).toMatchObject({ task: 'drift', mode: 'mock', note: MOCK_NOTE, rubricVersion: dataset.manifest.rubricVersion });
    expect(report.locales.vi?.samples).toBe(20);
    expect(report.locales.en?.samples).toBe(20);
  });
});
