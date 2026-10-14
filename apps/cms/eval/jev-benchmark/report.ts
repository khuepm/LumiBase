/**
 * Versioned benchmark reports (J06, #513).
 *
 * A report records what it measured: dataset version and manifest hash,
 * rubric version, protocol version, seed, split, mode and sample counts, with
 * VI and EN results kept apart. `mergeReports` builds a provider comparison
 * and refuses to combine reports that measured different things, above all
 * a `mock` report with a `live` one.
 */

import { BENCHMARK_BUNDLE_MARKER, countBy, type DatasetManifest, type Locale, type Split } from './dataset';
import { CALIBRATION_NOTE, summarizeCalls, type CallSummary, type Prices, type QuestionMetrics, type Rate } from './metrics';
import { callRecords, type SampleResult } from './runner';
import { evaluateAction, thresholdFor, type BenchmarkMode, type ThresholdFile } from './thresholds';

export const MOCK_NOTE =
  'mode: mock. Answers come from a seeded oracle over the gold labels; these numbers test the harness, not any model.';
export const TUNE_NOTE =
  'Tune split: thresholds were chosen on these samples, so the numbers are optimistic. Only heldout numbers estimate performance.';
export const DATASET_NOTE =
  'Synthetic hand-authored dataset with small per-locale samples; read every value with its Wilson 95% interval.';

export interface ActionResult {
  question: string;
  /** No confidence cut for choice questions, symmetric 0.5 for noul questions. */
  raw: QuestionMetrics;
  threshold: { value: number | null; status: string };
  /** Metrics at the frozen tune threshold, or null when tune found none. */
  atThreshold: QuestionMetrics | null;
}

export interface SliceMetrics {
  n: number;
  decided: number;
  coverage: Rate;
  selectivePrecision: Rate;
}

export interface LocaleResult {
  sampleCount: number;
  calls: CallSummary;
  actions: Record<string, ActionResult>;
  /** Raw (no-threshold) results per tag and action. */
  slices: Record<string, Record<string, SliceMetrics>>;
}

export interface ProviderRun {
  provider: string;
  model: string;
  reportedModels: string[];
  /** True/false when every response agreed, null when nothing answered or responses disagreed. */
  calibrated: boolean | null;
  thresholds: { source: 'derived-on-this-tune-run' | 'frozen-from-tune'; sha256: string };
  sampleCounts: Partial<Record<Locale, number>>;
  locales: Partial<Record<Locale, LocaleResult>>;
}

export interface BenchmarkReport {
  schema: 'lumibase.jev-benchmark.report/v1';
  generator: typeof BENCHMARK_BUNDLE_MARKER;
  mode: BenchmarkMode;
  split: Split;
  generatedAt: string;
  dataset: { version: string; manifestSha256: string; provenance: string };
  rubric: { version: string; presets: DatasetManifest['profile']['presets'] };
  protocol: DatasetManifest['protocol'];
  seed: number;
  sampleCounts: { total: number } & Partial<Record<Locale, number>>;
  runs: ProviderRun[];
  notes: string[];
}

export interface ProviderRunInput {
  manifest: DatasetManifest;
  results: readonly SampleResult[];
  provider: string;
  model: string;
  thresholds: ThresholdFile;
  thresholdsSha256: string;
  thresholdSource: ProviderRun['thresholds']['source'];
  prices: Prices | null;
}

function slice(metrics: QuestionMetrics): SliceMetrics {
  return { n: metrics.n, decided: metrics.decided, coverage: metrics.coverage, selectivePrecision: metrics.selectivePrecision };
}

export function buildProviderRun(input: ProviderRunInput): ProviderRun {
  const { manifest, results } = input;
  const locales: ProviderRun['locales'] = {};
  const sampleCounts: ProviderRun['sampleCounts'] = {};
  for (const locale of manifest.locales) {
    const localeResults = results.filter((r) => r.locale === locale);
    if (localeResults.length === 0) continue;
    sampleCounts[locale] = localeResults.length;
    const actions: Record<string, ActionResult> = {};
    const slices: LocaleResult['slices'] = {};
    for (const [action, spec] of Object.entries(manifest.protocol.actions)) {
      const value = thresholdFor(input.thresholds, locale, action);
      actions[action] = {
        question: spec.question,
        raw: evaluateAction(manifest, localeResults, spec.question, null),
        threshold: { value, status: input.thresholds.thresholds[locale]?.[action]?.status ?? 'missing' },
        atThreshold: value === null ? null : evaluateAction(manifest, localeResults, spec.question, value),
      };
      for (const tag of manifest.requiredTags) {
        const tagged = localeResults.filter((r) => r.tags.includes(tag));
        if (tagged.length === 0) continue;
        slices[tag] ??= {};
        slices[tag][action] = slice(evaluateAction(manifest, tagged, spec.question, null));
      }
    }
    locales[locale] = {
      sampleCount: localeResults.length,
      calls: summarizeCalls(callRecords(localeResults), input.prices),
      actions,
      slices,
    };
  }
  const flags = [...new Set(results.flatMap((r) => (r.response ? [r.response.calibrated] : [])))];
  return {
    provider: input.provider,
    model: input.model,
    reportedModels: [...new Set(results.flatMap((r) => (r.response ? [r.response.model] : [])))].sort(),
    calibrated: flags.length === 1 ? flags[0]! : null,
    thresholds: { source: input.thresholdSource, sha256: input.thresholdsSha256 },
    sampleCounts,
    locales,
  };
}

export interface ReportInput {
  manifest: DatasetManifest;
  manifestSha256: string;
  rubricVersion: string;
  mode: BenchmarkMode;
  split: Split;
  generatedAt: string;
  results: readonly SampleResult[];
  run: ProviderRun;
}

export function buildReport(input: ReportInput): BenchmarkReport {
  const counts = countBy(input.results, (r) => r.locale);
  const notes = [DATASET_NOTE, CALIBRATION_NOTE];
  if (input.split === 'tune') notes.push(TUNE_NOTE);
  if (input.mode === 'mock') notes.unshift(MOCK_NOTE);
  return {
    schema: 'lumibase.jev-benchmark.report/v1',
    generator: BENCHMARK_BUNDLE_MARKER,
    mode: input.mode,
    split: input.split,
    generatedAt: input.generatedAt,
    dataset: {
      version: input.manifest.datasetVersion,
      manifestSha256: input.manifestSha256,
      provenance: input.manifest.provenance,
    },
    rubric: { version: input.rubricVersion, presets: input.manifest.profile.presets },
    protocol: input.manifest.protocol,
    seed: input.manifest.seed,
    sampleCounts: { total: input.results.length, ...counts },
    runs: [input.run],
    notes,
  };
}

export class ReportMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportMergeError';
  }
}

/**
 * Combines per-provider reports into one comparison. Every report must share
 * mode, split, dataset (version and manifest hash), rubric, protocol and
 * seed; mixing a mock report into a live comparison is always refused.
 */
export function mergeReports(reports: readonly BenchmarkReport[], generatedAt: string): BenchmarkReport {
  const first = reports[0];
  if (!first) throw new ReportMergeError('Nothing to merge.');
  const modes = new Set(reports.map((r) => r.mode));
  if (modes.size > 1) {
    throw new ReportMergeError(`Refusing to merge reports of different modes (${[...modes].join(', ')}): mock results never mix with live ones.`);
  }
  const checks: Array<[string, (r: BenchmarkReport) => unknown]> = [
    ['schema', (r) => r.schema],
    ['split', (r) => r.split],
    ['dataset version', (r) => r.dataset.version],
    ['dataset manifest', (r) => r.dataset.manifestSha256],
    ['rubric version', (r) => r.rubric.version],
    ['protocol version', (r) => r.protocol.version],
    ['seed', (r) => r.seed],
    ['sample counts', (r) => JSON.stringify(r.sampleCounts)],
  ];
  for (const [label, read] of checks) {
    const values = new Set(reports.map(read));
    if (values.size > 1) throw new ReportMergeError(`Refusing to merge reports with different ${label}: ${[...values].join(' vs ')}.`);
  }
  const runs = reports.flatMap((r) => r.runs);
  const seen = new Set<string>();
  for (const run of runs) {
    const key = `${run.provider}:${run.model}`;
    if (seen.has(key)) throw new ReportMergeError(`Provider ${key} appears in more than one report.`);
    seen.add(key);
  }
  return {
    ...first,
    generatedAt,
    runs,
    notes: [...new Set(reports.flatMap((r) => r.notes))],
  };
}
