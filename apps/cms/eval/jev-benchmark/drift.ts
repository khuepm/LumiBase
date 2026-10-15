/**
 * Semantic drift task of the Jev benchmark (J12, #519): `--task drift`.
 *
 * Each sample is a brief (the `field:brief` context of a semantic intent
 * rule) plus the content written for it, labelled `drift: true` when the
 * content strays from the brief. Tags cover true drift, false-positive traps
 * (content that looks off but is on brief), aligned content and prompt
 * injection (content that tells the model to call it aligned).
 *
 * Scoring uses the production mapping (`semanticOutcome` in
 * `src/services/semantic-drift.ts`) at the rule's fixed threshold, so the
 * benchmark measures what the drift scan would record: drift, clean or
 * unevaluated. A failed call counts as unevaluated, never as clean. There is
 * no tune split: the threshold is part of the rule, not derived here.
 *
 * Like the editorial dataset, every sample is hand-authored synthetic
 * content; none of it is customer or user data.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { DecisionProvider, DecisionQuestion } from '../../src/services/decision-provider';
import { semanticOutcome } from '../../src/services/semantic-drift';
import { BENCHMARK_BUNDLE_MARKER, DATASETS_ROOT, LOCALES, sha256Hex, type BenchmarkSample, type Locale } from './dataset';
import { rate, summarizeCalls, type CallSummary, type Prices, type Rate } from './metrics';
import { MOCK_NOTE } from './report';
import { benchmarkRubricVersion } from './rubric';
import { callRecords, runSamples, type SampleResult } from './runner';
import type { BenchmarkMode } from './thresholds';

export const DRIFT_MANIFEST = 'drift.manifest.json';

const driftManifestSchema = z
  .object({
    schema: z.literal('lumibase.jev-benchmark.drift/v1'),
    datasetVersion: z.string().min(1),
    createdAt: z.string().min(1),
    provenance: z.string().min(1),
    seed: z.number().int(),
    fields: z.array(z.string().min(1)).min(1),
    contextField: z.string().min(1),
    annotationGuidelines: z.record(z.string(), z.string()),
    requiredTags: z.array(z.string().min(1)).min(1),
    /** The semantic intent rule the samples are judged under. */
    rule: z
      .object({
        key: z.string().min(1),
        version: z.number().int().min(1),
        questionKey: z.string().min(1),
        threshold: z.number().min(0.5).max(1),
        contextSource: z.string().regex(/^field:/),
      })
      .strict(),
    question: z
      .object({
        type: z.literal('noul'),
        instructions: z.string().min(1),
        criteria: z.object({ true: z.string().min(1), false: z.string().min(1) }).strict(),
      })
      .strict(),
    rubricVersion: z.string().regex(/^sha256:[0-9a-f]{16}$/),
    protocol: z
      .object({
        version: z.string().min(1),
        interval: z.literal('wilson-95'),
        percentile: z.literal('nearest-rank'),
        mock: z.object({ accuracy: z.number().min(0).max(1), failureRate: z.number().min(0).max(1) }).strict(),
      })
      .strict(),
    files: z.record(
      z.string(),
      z.object({ locale: z.enum(LOCALES), count: z.number().int().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
    ),
  })
  .strict();
export type DriftManifest = z.infer<typeof driftManifestSchema>;

const driftSampleSchema = z
  .object({
    id: z.string().regex(/^drift-[a-z]{2}-\d{3}$/),
    locale: z.enum(LOCALES),
    fields: z.record(z.string(), z.string()),
    labels: z.object({ drift: z.boolean() }).strict(),
    tags: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type DriftSample = z.infer<typeof driftSampleSchema>;

export interface LoadedDriftDataset {
  manifest: DriftManifest;
  manifestSha256: string;
  samples: DriftSample[];
}

/** Loads and verifies `datasets/<version>/drift.*`: hashes, counts, fields, tags. Throws on any mismatch. */
export function loadDriftDataset(version: string, root: string = DATASETS_ROOT): LoadedDriftDataset {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(version)) throw new Error(`Invalid dataset version "${version}"`);
  const dir = join(root, version);
  const manifestText = readFileSync(join(dir, DRIFT_MANIFEST), 'utf8');
  const manifest = driftManifestSchema.parse(JSON.parse(manifestText));
  if (manifest.datasetVersion !== version) {
    throw new Error(`${DRIFT_MANIFEST} declares datasetVersion "${manifest.datasetVersion}", expected "${version}"`);
  }
  if (!manifest.fields.includes(manifest.contextField)) throw new Error(`contextField "${manifest.contextField}" is not a field`);
  if (manifest.rule.contextSource !== `field:${manifest.contextField}`) {
    throw new Error(`rule.contextSource must be "field:${manifest.contextField}"`);
  }
  const rubric = benchmarkRubricVersion(driftQuestions(manifest));
  if (rubric !== manifest.rubricVersion) {
    throw new Error(`Rubric drift: the drift question is ${rubric}, the dataset was frozen at ${manifest.rubricVersion}. Publish a new version.`);
  }

  const samples: DriftSample[] = [];
  const seen = new Set<string>();
  const expectedFields = [...manifest.fields].sort().join(',');
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (!/^drift\.[a-z]{2}\.jsonl$/.test(name)) throw new Error(`Unexpected drift file name "${name}"`);
    const bytes = readFileSync(join(dir, name));
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) throw new Error(`${name}: sha256 is ${actual}, manifest says ${entry.sha256}. Bump the dataset version instead of editing it.`);
    const lines = new TextDecoder().decode(bytes).split('\n').filter((line) => line.trim() !== '');
    if (lines.length !== entry.count) throw new Error(`${name}: ${lines.length} samples, manifest says ${entry.count}`);
    lines.forEach((line, index) => {
      const where = `${name}:${index + 1}`;
      const parsed = driftSampleSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(`${where}: ${parsed.error.issues[0]?.message ?? 'invalid sample'}`);
      const sample = parsed.data;
      if (sample.locale !== entry.locale) throw new Error(`${where}: sample says ${sample.locale}, file is ${entry.locale}`);
      if (Object.keys(sample.fields).sort().join(',') !== expectedFields) throw new Error(`${where}: fields must be exactly ${expectedFields}`);
      for (const tag of sample.tags) if (!manifest.requiredTags.includes(tag)) throw new Error(`${where}: unknown tag "${tag}"`);
      if (seen.has(sample.id)) throw new Error(`${where}: duplicate sample id "${sample.id}"`);
      seen.add(sample.id);
      samples.push(sample);
    });
  }
  return { manifest, manifestSha256: sha256Hex(manifestText), samples };
}

/** The one question the samples are judged with, keyed like the rule's `questionKey`. */
export function driftQuestions(manifest: DriftManifest): Record<string, DecisionQuestion> {
  return { [manifest.rule.questionKey]: manifest.question as DecisionQuestion };
}

/**
 * Adapts drift samples to the shared runner (and the mock oracle, which
 * answers from `labels[questionKey]`). The split is fixed: there is no tune
 * split for drift.
 */
export function asRunnerSamples(manifest: DriftManifest, samples: readonly DriftSample[]): BenchmarkSample[] {
  return samples.map((sample) => ({
    id: sample.id,
    locale: sample.locale,
    split: 'heldout',
    fields: { ...sample.fields },
    labels: { [manifest.rule.questionKey]: sample.labels.drift },
    tags: [...sample.tags],
  }));
}

export type DriftPrediction = 'drift' | 'clean' | 'unevaluated';

/** What the drift scan would record for this result. A failed call is unevaluated. */
export function driftPrediction(result: SampleResult, questionKey: string, threshold: number): DriftPrediction {
  if (result.error !== null || !result.response) return 'unevaluated';
  const answer = result.response.answers[questionKey];
  return semanticOutcome(answer?.type === 'noul' ? answer.noul : null, threshold).kind;
}

export interface DriftLocaleMetrics {
  samples: number;
  outcomes: Record<DriftPrediction, number>;
  /** Conclusive (drift or clean) over all samples. */
  coverage: Rate;
  /** Gold drift among predicted drift. */
  precision: Rate;
  /** Predicted drift among gold drift; unevaluated counts as not detected. */
  recall: Rate;
  /** Predicted drift among `false-positive-trap` samples (lower is better). */
  falsePositiveTrapRate: Rate;
  /** Predicted drift among `prompt-injection` samples (all are gold drift). */
  injectionDetected: Rate;
  calls: CallSummary;
}

export function driftLocaleMetrics(
  results: readonly SampleResult[],
  questionKey: string,
  threshold: number,
  prices: Prices | null,
): DriftLocaleMetrics {
  const predictions = results.map((r) => ({ r, p: driftPrediction(r, questionKey, threshold), gold: r.labels[questionKey] === true }));
  const count = (p: DriftPrediction) => predictions.filter((x) => x.p === p).length;
  const tagged = (tag: string) => predictions.filter((x) => x.r.tags.includes(tag));
  const predictedDrift = predictions.filter((x) => x.p === 'drift');
  const goldDrift = predictions.filter((x) => x.gold);
  const traps = tagged('false-positive-trap');
  const injections = tagged('prompt-injection');
  return {
    samples: results.length,
    outcomes: { drift: count('drift'), clean: count('clean'), unevaluated: count('unevaluated') },
    coverage: rate(count('drift') + count('clean'), results.length),
    precision: rate(predictedDrift.filter((x) => x.gold).length, predictedDrift.length),
    recall: rate(goldDrift.filter((x) => x.p === 'drift').length, goldDrift.length),
    falsePositiveTrapRate: rate(traps.filter((x) => x.p === 'drift').length, traps.length),
    injectionDetected: rate(injections.filter((x) => x.p === 'drift').length, injections.length),
    calls: summarizeCalls(callRecords(results), prices),
  };
}

export interface DriftReport {
  schema: 'lumibase.jev-benchmark.drift-report/v1';
  marker: typeof BENCHMARK_BUNDLE_MARKER;
  task: 'drift';
  mode: BenchmarkMode;
  /** Set for mock runs: the numbers say nothing about any model. */
  note: string | null;
  generatedAt: string;
  datasetVersion: string;
  manifestSha256: string;
  rubricVersion: string;
  protocolVersion: string;
  rule: DriftManifest['rule'];
  provider: string;
  model: string;
  locales: Partial<Record<Locale, DriftLocaleMetrics>>;
}

export async function runDriftBenchmark(input: {
  dataset: LoadedDriftDataset;
  provider: DecisionProvider;
  providerName: string;
  model: string;
  mode: BenchmarkMode;
  generatedAt: string;
  concurrency?: number;
  prices?: Prices | null;
}): Promise<{ report: DriftReport; results: SampleResult[] }> {
  const { manifest } = input.dataset;
  const samples = asRunnerSamples(manifest, input.dataset.samples);
  const results = await runSamples(input.provider, samples, driftQuestions(manifest), { concurrency: input.concurrency ?? 1 });
  const locales: Partial<Record<Locale, DriftLocaleMetrics>> = {};
  for (const locale of LOCALES) {
    const subset = results.filter((r) => r.locale === locale);
    if (subset.length > 0) {
      locales[locale] = driftLocaleMetrics(subset, manifest.rule.questionKey, manifest.rule.threshold, input.prices ?? null);
    }
  }
  return {
    results,
    report: {
      schema: 'lumibase.jev-benchmark.drift-report/v1',
      marker: BENCHMARK_BUNDLE_MARKER,
      task: 'drift',
      mode: input.mode,
      note: input.mode === 'mock' ? MOCK_NOTE : null,
      generatedAt: input.generatedAt,
      datasetVersion: manifest.datasetVersion,
      manifestSha256: input.dataset.manifestSha256,
      rubricVersion: manifest.rubricVersion,
      protocolVersion: manifest.protocol.version,
      rule: manifest.rule,
      provider: input.providerName,
      model: input.model,
      locales,
    },
  };
}
