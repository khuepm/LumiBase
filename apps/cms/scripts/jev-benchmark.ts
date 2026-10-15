#!/usr/bin/env tsx
/**
 * Jev benchmark harness (J06, #513).
 *
 *   pnpm -F @lumibase/cms bench:jev -- --provider mock --split tune
 *   pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split tune
 *   pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split heldout
 *   pnpm -F @lumibase/cms bench:jev -- --merge a.json --merge b.json --out comparison.json
 *   pnpm -F @lumibase/cms bench:jev -- --task drift --provider mock
 *
 * Providers: `mock` (seeded oracle, no network) or a decision provider from
 * `createDecisionProvider` — `typesafe` (TYPESAFE_API_KEY), `openrouter`
 * (OPENROUTER_API_KEY) or `llm` (LLM_PROVIDER + its key). Live runs send the
 * synthetic dataset to that provider and are billed by it.
 *
 * `--split tune` derives thresholds from tune and writes them with the
 * report. `--split heldout` loads those frozen thresholds and never writes
 * any. Lives outside `src/`, so none of it is in the Worker bundle.
 *
 * `--task drift` (J12, #519) scores the semantic drift fixtures
 * (`datasets/<v>/drift.*`) at the rule's fixed threshold with the same
 * mapping the drift scan uses. It has no tune split and writes no thresholds.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDecisionProvider, type DecisionProvider, type DecisionProviderEnv } from '../src/services/decision-provider';
import { loadDataset, samplesFor, SPLITS, type BenchmarkSample, type Split } from '../eval/jev-benchmark/dataset';
import { asRunnerSamples, loadDriftDataset, runDriftBenchmark } from '../eval/jev-benchmark/drift';
import type { Prices } from '../eval/jev-benchmark/metrics';
import { MOCK_MODEL, MOCK_PROVIDER, MockOracleProvider } from '../eval/jev-benchmark/mock-provider';
import { buildProviderRun, buildReport, mergeReports, parseBenchmarkReport } from '../eval/jev-benchmark/report';
import { benchmarkRubricVersion, buildBenchmarkQuestions } from '../eval/jev-benchmark/rubric';
import { runSamples } from '../eval/jev-benchmark/runner';
import {
  assertThresholdsMatch,
  assertThresholdsNotFrozen,
  deriveThresholds,
  loadFrozenThresholds,
  writeThresholds,
  type BenchmarkMode,
  type ThresholdIdentity,
} from '../eval/jev-benchmark/thresholds';

const CMS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_PROVIDERS = ['typesafe', 'openrouter', 'llm'] as const;

const USAGE = `Usage:
  bench:jev -- --task drift --provider <mock|typesafe|openrouter|llm> [--dataset v1] [--out <dir>] [--concurrency <n>]
  bench:jev -- --provider <mock|typesafe|openrouter|llm> --split <tune|heldout> [--dataset v1] [--out <dir>]
             [--thresholds <file>] [--concurrency <n>] [--price-input-per-mtok <usd>] [--price-output-per-mtok <usd>]
  bench:jev -- --merge <report.json> --merge <report.json> --out <comparison.json>`;

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

function positiveNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a non-negative number, got "${raw}"`);
  return value;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const { values } = parseArgs({
  // pnpm forwards a literal `--` separator.
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    task: { type: 'string', default: 'editorial' },
    provider: { type: 'string' },
    split: { type: 'string' },
    dataset: { type: 'string', default: 'v1' },
    out: { type: 'string' },
    thresholds: { type: 'string' },
    concurrency: { type: 'string', default: '1' },
    merge: { type: 'string', multiple: true },
    'price-input-per-mtok': { type: 'string' },
    'price-output-per-mtok': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (values.merge && values.merge.length > 0) {
  if (!values.out) fail('--merge needs --out <file>');
  const reports = (() => {
    try {
      return values.merge!.map((file) => parseBenchmarkReport(JSON.parse(readFileSync(resolve(file), 'utf8')), file));
    } catch (err) {
      return fail((err as Error).message);
    }
  })();
  try {
    const merged = mergeReports(reports, new Date().toISOString());
    writeJson(resolve(values.out), merged);
    console.log(`Merged ${reports.length} ${merged.mode} reports → ${resolve(values.out)}`);
  } catch (err) {
    fail((err as Error).message);
  }
  process.exit(0);
}

function resolveProvider(
  name: string,
  mockSamples: readonly BenchmarkSample[],
  mock: { seed: number; accuracy: number; failureRate: number },
): { provider: DecisionProvider; model: string; mode: BenchmarkMode } {
  if (name === MOCK_PROVIDER) {
    return { mode: 'mock', model: MOCK_MODEL, provider: new MockOracleProvider({ ...mock, samples: mockSamples }) };
  }
  if ((LIVE_PROVIDERS as readonly string[]).includes(name)) {
    const env: DecisionProviderEnv = { ...(process.env as DecisionProviderEnv), DECISION_PROVIDER: name };
    const configured = createDecisionProvider(env);
    if (!configured) {
      fail(
        `Provider "${name}" is not configured. Set ${
          name === 'typesafe' ? 'TYPESAFE_API_KEY' : name === 'openrouter' ? 'OPENROUTER_API_KEY' : 'LLM_PROVIDER and its API key'
        }.`,
        2,
      );
    }
    return { mode: 'live', model: configured.model, provider: configured.provider };
  }
  return fail(`Unknown provider "${name}". Use mock, ${LIVE_PROVIDERS.join(', ')}.`);
}

if (values.task !== 'editorial' && values.task !== 'drift') fail(`--task must be editorial or drift\n${USAGE}`);

if (values.task === 'drift') {
  const name = values.provider;
  if (!name) fail(`--provider is required\n${USAGE}`);
  const concurrencyDrift = Number(values.concurrency);
  if (!Number.isInteger(concurrencyDrift) || concurrencyDrift < 1 || concurrencyDrift > 16) fail('--concurrency must be an integer in 1..16');
  let driftDataset;
  try {
    driftDataset = loadDriftDataset(values.dataset);
  } catch (err) {
    fail((err as Error).message);
  }
  const { manifest: driftManifest } = driftDataset;
  const resolved = resolveProvider(name, asRunnerSamples(driftManifest, driftDataset.samples), {
    seed: driftManifest.seed,
    accuracy: driftManifest.protocol.mock.accuracy,
    failureRate: driftManifest.protocol.mock.failureRate,
  });
  console.log(`Running ${driftDataset.samples.length} drift samples (${resolved.mode}) against ${name} / ${resolved.model} …`);
  const { report, results } = await runDriftBenchmark({
    dataset: driftDataset,
    provider: resolved.provider,
    providerName: name,
    model: resolved.model,
    mode: resolved.mode,
    generatedAt: new Date().toISOString(),
    concurrency: concurrencyDrift,
  });
  const dir = resolve(values.out ?? join(CMS_ROOT, 'eval/jev-benchmark/reports', driftManifest.datasetVersion, name));
  const reportPath = join(dir, 'report.drift.json');
  writeJson(reportPath, report);
  writeFileSync(
    join(dir, 'results.drift.jsonl'),
    results.map((r) => JSON.stringify({
      id: r.id,
      locale: r.locale,
      latencyMs: Math.round(r.latencyMs),
      error: r.error,
      model: r.response?.model ?? null,
      answers: r.response?.answers ?? null,
    })).join('\n') + '\n',
  );
  for (const [locale, metrics] of Object.entries(report.locales)) {
    if (!metrics) continue;
    console.log(`  ${locale}: ${metrics.samples} samples, ${metrics.outcomes.drift} drift / ${metrics.outcomes.clean} clean / ${metrics.outcomes.unevaluated} unevaluated`);
  }
  console.log(`Drift report (${resolved.mode}, dataset ${driftManifest.datasetVersion}, rubric ${driftManifest.rubricVersion}) → ${reportPath}`);
  process.exit(0);
}

const providerName = values.provider;
if (!providerName) fail(`--provider is required\n${USAGE}`);
if (!values.split || !(SPLITS as readonly string[]).includes(values.split)) fail(`--split must be tune or heldout\n${USAGE}`);
const split = values.split as Split;
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) fail('--concurrency must be an integer in 1..16');
const priceIn = positiveNumber(values['price-input-per-mtok'], 'price-input-per-mtok');
const priceOut = positiveNumber(values['price-output-per-mtok'], 'price-output-per-mtok');
if ((priceIn === undefined) !== (priceOut === undefined)) fail('Give both --price-input-per-mtok and --price-output-per-mtok, or neither.');
const prices: Prices | null = priceIn === undefined ? null : { inputPerMTok: priceIn, outputPerMTok: priceOut! };

const dataset = loadDataset(values.dataset);
const { manifest } = dataset;
const questions = buildBenchmarkQuestions(manifest);
const rubricVersion = benchmarkRubricVersion(questions);
if (rubricVersion !== manifest.profile.rubricVersion) {
  fail(
    `Rubric drift: the presets now build ${rubricVersion}, the dataset was frozen at ${manifest.profile.rubricVersion}.\n`
      + 'Results from two rubrics are not comparable. Publish a new dataset/protocol version instead of editing this one.',
  );
}

const samples = samplesFor(dataset.samples, split);

const { provider, model, mode } = resolveProvider(providerName, samples, {
  seed: manifest.seed,
  accuracy: manifest.protocol.mock.accuracy,
  failureRate: manifest.protocol.mock.failureRate,
});

const identity: ThresholdIdentity = {
  mode,
  provider: providerName,
  model,
  datasetVersion: manifest.datasetVersion,
  manifestSha256: dataset.manifestSha256,
  rubricVersion,
  protocolVersion: manifest.protocol.version,
};

const outDir = resolve(values.out ?? join(CMS_ROOT, 'eval/jev-benchmark/reports', manifest.datasetVersion, providerName));
const thresholdsPath = resolve(values.thresholds ?? join(outDir, 'thresholds.json'));

// Held-out: load and check the frozen thresholds BEFORE spending any call.
const frozen = split === 'heldout' ? loadFrozenThresholdsOrFail(thresholdsPath, identity) : null;
// Tune: refuse to overwrite thresholds a held-out report was already scored with.
if (split === 'tune') {
  try {
    assertThresholdsNotFrozen(thresholdsPath, [outDir, dirname(thresholdsPath)]);
  } catch (err) {
    fail((err as Error).message, 2);
  }
}

function loadFrozenThresholdsOrFail(path: string, expected: ThresholdIdentity) {
  try {
    const loaded = loadFrozenThresholds(path);
    assertThresholdsMatch(loaded.file, expected);
    return loaded;
  } catch (err) {
    return fail((err as Error).message);
  }
}

console.log(`Running ${samples.length} ${split} samples (${mode}) against ${providerName} / ${model} …`);
const results = await runSamples(provider, samples, questions, { concurrency });

let thresholds = frozen?.file;
let thresholdsSha256 = frozen?.sha256;
if (split === 'tune') {
  thresholds = deriveThresholds(manifest, identity, results);
  thresholdsSha256 = writeThresholds(thresholdsPath, thresholds, split);
  console.log(`Thresholds derived from tune → ${thresholdsPath}`);
}

const run = buildProviderRun({
  manifest,
  results,
  provider: providerName,
  model,
  thresholds: thresholds!,
  thresholdsSha256: thresholdsSha256!,
  thresholdSource: split === 'tune' ? 'derived-on-this-tune-run' : 'frozen-from-tune',
  prices,
});
const report = buildReport({
  manifest,
  manifestSha256: dataset.manifestSha256,
  rubricVersion,
  mode,
  split,
  generatedAt: new Date().toISOString(),
  results,
  run,
});

const reportPath = join(outDir, `report.${split}.json`);
writeJson(reportPath, report);
// Per-sample answers without content, for audit and re-scoring.
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, `results.${split}.jsonl`),
  results.map((r) => JSON.stringify({
    id: r.id,
    locale: r.locale,
    latencyMs: Math.round(r.latencyMs),
    error: r.error,
    model: r.response?.model ?? null,
    answers: r.response?.answers ?? null,
    usage: r.response?.usage ?? null,
  })).join('\n') + '\n',
);

for (const [locale, result] of Object.entries(run.locales)) {
  if (!result) continue;
  const failures = result.calls.failures;
  console.log(`  ${locale}: ${result.sampleCount} samples, ${failures.k} failed (${result.calls.timeouts.k} timeouts)`);
}
console.log(`Report (${mode}, dataset ${manifest.datasetVersion}, rubric ${rubricVersion}) → ${reportPath}`);
