/**
 * Leakage guard (J06, #513): thresholds come from the `tune` split only.
 *
 *   - `deriveThresholds` refuses any result that is not from `tune`.
 *   - `writeThresholds` refuses to write for any split other than `tune`.
 *   - A `heldout` run loads the frozen file with `loadFrozenThresholds` and
 *     checks it was derived for the same mode, provider, model, dataset,
 *     rubric and protocol (`assertThresholdsMatch`). It never writes one.
 *   - Once a held-out report used a thresholds file, a later tune run may not
 *     overwrite it (`assertThresholdsNotFrozen`): re-tuning after seeing
 *     held-out numbers would leak them into the thresholds across runs. A
 *     new protocol run uses a new `--out` directory.
 *
 * A threshold is the lowest grid value whose selective precision on `tune`
 * reaches the action's target with at least `minCoveredSamples` decided
 * samples. It is a cut on the provider's reported score, chosen for an
 * acceptable error rate; it does not turn the score into a probability of
 * being right.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { BENCHMARK_BUNDLE_MARKER, LOCALES, SPLITS, sha256Hex, type DatasetManifest, type Locale, type Split } from './dataset';
import { evaluateChoice, evaluateNoul, type QuestionMetrics } from './metrics';
import { choiceObservations, noulObservations, type SampleResult } from './runner';

export const BENCHMARK_MODES = ['mock', 'live'] as const;
export type BenchmarkMode = (typeof BENCHMARK_MODES)[number];

export class LeakageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeakageError';
  }
}

export interface ThresholdIdentity {
  mode: BenchmarkMode;
  provider: string;
  model: string;
  datasetVersion: string;
  manifestSha256: string;
  rubricVersion: string;
  protocolVersion: string;
}

const entrySchema = z.object({
  question: z.string(),
  kind: z.enum(['choice', 'noul']),
  value: z.number().min(0).max(1).nullable(),
  targetPrecision: z.number(),
  status: z.enum(['target-reached', 'target-not-reached']),
  tune: z.object({
    n: z.number().int(),
    decided: z.number().int(),
    selectivePrecision: z.number().nullable(),
    coverage: z.number().nullable(),
  }),
}).strict();
export type ThresholdEntry = z.infer<typeof entrySchema>;

const thresholdFileSchema = z.object({
  schema: z.literal('lumibase.jev-benchmark.thresholds/v1'),
  generator: z.literal(BENCHMARK_BUNDLE_MARKER),
  mode: z.enum(BENCHMARK_MODES),
  provider: z.string(),
  model: z.string(),
  datasetVersion: z.string(),
  manifestSha256: z.string(),
  rubricVersion: z.string(),
  protocolVersion: z.string(),
  derivedFrom: z.object({
    split: z.literal('tune'),
    sampleCounts: z.partialRecord(z.enum(LOCALES), z.number().int()),
  }).strict(),
  reportedModels: z.array(z.string()),
  thresholds: z.partialRecord(z.enum(LOCALES), z.record(z.string(), entrySchema)),
}).strict();
export type ThresholdFile = z.infer<typeof thresholdFileSchema>;

/** Throws LeakageError unless every result comes from the `tune` split. */
export function assertTuneOnly(results: ReadonlyArray<{ id: string; split: Split }>): void {
  const leaked = results.filter((r) => r.split !== 'tune');
  if (leaked.length > 0) {
    throw new LeakageError(
      `Thresholds may only be derived from the tune split; got ${leaked.length} non-tune sample(s), e.g. ${leaked[0]!.id}.`,
    );
  }
}

export interface ThresholdSelection {
  value: number | null;
  reached: boolean;
  metrics: QuestionMetrics;
}

/** Lowest grid value whose selective precision reaches `target` with enough decided samples. */
export function selectThreshold(
  grid: readonly number[],
  evaluate: (threshold: number) => QuestionMetrics,
  target: number,
  minCovered: number,
): ThresholdSelection {
  const sorted = [...grid].sort((a, b) => a - b);
  for (const value of sorted) {
    const metrics = evaluate(value);
    const precision = metrics.selectivePrecision.value;
    if (metrics.decided >= minCovered && precision !== null && precision >= target) {
      return { value, reached: true, metrics };
    }
  }
  // Recorded for transparency: what the strictest candidate achieved.
  return { value: null, reached: false, metrics: evaluate(sorted[sorted.length - 1]!) };
}

export function evaluateAction(
  manifest: DatasetManifest,
  results: readonly SampleResult[],
  question: string,
  threshold: number | null,
): QuestionMetrics {
  const spec = manifest.labelSchema[question];
  if (!spec) throw new Error(`No label schema for "${question}"`);
  const bins = manifest.protocol.eceBins;
  if (spec.type === 'choice') return evaluateChoice(choiceObservations(results, question), spec, threshold, bins);
  return evaluateNoul(noulObservations(results, question), threshold ?? 0.5, bins);
}

export function deriveThresholds(
  manifest: DatasetManifest,
  identity: ThresholdIdentity,
  results: readonly SampleResult[],
): ThresholdFile {
  assertTuneOnly(results);
  const thresholds: ThresholdFile['thresholds'] = {};
  const sampleCounts: ThresholdFile['derivedFrom']['sampleCounts'] = {};
  for (const locale of manifest.locales) {
    const localeResults = results.filter((r) => r.locale === locale);
    sampleCounts[locale] = localeResults.length;
    const entries: Record<string, ThresholdEntry> = {};
    for (const [action, spec] of Object.entries(manifest.protocol.actions)) {
      const kind = manifest.labelSchema[spec.question]?.type;
      if (!kind) throw new Error(`Action "${action}" uses unknown question "${spec.question}"`);
      const selection = selectThreshold(
        spec.grid,
        (t) => evaluateAction(manifest, localeResults, spec.question, t),
        spec.targetPrecision,
        manifest.protocol.minCoveredSamples,
      );
      entries[action] = {
        question: spec.question,
        kind,
        value: selection.value,
        targetPrecision: spec.targetPrecision,
        status: selection.reached ? 'target-reached' : 'target-not-reached',
        tune: {
          n: selection.metrics.n,
          decided: selection.metrics.decided,
          selectivePrecision: selection.metrics.selectivePrecision.value,
          coverage: selection.metrics.coverage.value,
        },
      };
    }
    thresholds[locale] = entries;
  }
  const reportedModels = [...new Set(results.flatMap((r) => (r.response ? [r.response.model] : [])))].sort();
  return {
    schema: 'lumibase.jev-benchmark.thresholds/v1',
    generator: BENCHMARK_BUNDLE_MARKER,
    ...identity,
    derivedFrom: { split: 'tune', sampleCounts },
    reportedModels,
    thresholds,
  };
}

/** Writes the threshold file. Throws LeakageError for any split but `tune`; nothing is written then. */
export function writeThresholds(path: string, file: ThresholdFile, split: Split): string {
  if (!SPLITS.includes(split) || split !== 'tune' || file.derivedFrom.split !== 'tune') {
    throw new LeakageError(`Refusing to write thresholds from a ${split} run: thresholds are frozen after tune.`);
  }
  const text = `${JSON.stringify(thresholdFileSchema.parse(file), null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return sha256Hex(text);
}

export function parseThresholds(text: string): ThresholdFile {
  return thresholdFileSchema.parse(JSON.parse(text));
}

export function loadFrozenThresholds(path: string): { file: ThresholdFile; sha256: string } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`No frozen thresholds at ${path}. Run the tune split first (--split tune) for the same provider.`);
  }
  return { file: parseThresholds(text), sha256: sha256Hex(text) };
}

/**
 * Throws LeakageError when the thresholds file at `path` was already used by a
 * held-out report (`report.heldout*.json` in one of `reportDirs` whose run
 * records the file's sha256). Called before a tune run spends any call.
 */
export function assertThresholdsNotFrozen(path: string, reportDirs: readonly string[]): void {
  if (!existsSync(path)) return;
  const sha = sha256Hex(readFileSync(path, 'utf8'));
  for (const dir of new Set(reportDirs)) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/^report\.heldout.*\.json$/.test(name)) continue;
      let report: { runs?: Array<{ thresholds?: { sha256?: unknown } }> };
      try {
        report = JSON.parse(readFileSync(join(dir, name), 'utf8')) as typeof report;
      } catch {
        continue;
      }
      if ((report.runs ?? []).some((run) => run.thresholds?.sha256 === sha)) {
        throw new LeakageError(
          `Thresholds at ${path} are frozen: ${join(dir, name)} was scored with them. `
            + 'Re-tuning now would let held-out results shape the thresholds. Use a new --out directory for a new protocol run.',
        );
      }
    }
  }
}

/** Throws when the frozen thresholds were derived for a different setup. */
export function assertThresholdsMatch(file: ThresholdFile, identity: ThresholdIdentity): void {
  const mismatches = (Object.keys(identity) as Array<keyof ThresholdIdentity>)
    .filter((key) => file[key] !== identity[key])
    .map((key) => `${key}: thresholds have "${file[key]}", this run has "${identity[key]}"`);
  if (mismatches.length > 0) {
    throw new Error(`Frozen thresholds do not match this run:\n- ${mismatches.join('\n- ')}`);
  }
}

export function thresholdFor(file: ThresholdFile, locale: Locale, action: string): number | null {
  return file.thresholds[locale]?.[action]?.value ?? null;
}
