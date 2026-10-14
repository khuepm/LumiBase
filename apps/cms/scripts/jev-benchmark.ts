#!/usr/bin/env tsx
/**
 * Jev benchmark harness (J06, #513).
 *
 *   pnpm -F @lumibase/cms bench:jev -- --provider mock --split tune
 *   pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split tune
 *   pnpm -F @lumibase/cms bench:jev -- --provider typesafe --split heldout
 *   pnpm -F @lumibase/cms bench:jev -- --merge a.json --merge b.json --out comparison.json
 *
 * Providers: `mock` (seeded oracle, no network) or a decision provider from
 * `createDecisionProvider` — `typesafe` (TYPESAFE_API_KEY), `openrouter`
 * (OPENROUTER_API_KEY) or `llm` (LLM_PROVIDER + its key). Live runs send the
 * synthetic dataset to that provider and are billed by it.
 *
 * `--split tune` derives thresholds from tune and writes them with the
 * report. `--split heldout` loads those frozen thresholds and never writes
 * any. Lives outside `src/`, so none of it is in the Worker bundle.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDecisionProvider, type DecisionProvider, type DecisionProviderEnv } from '../src/services/decision-provider';
import { loadDataset, samplesFor, SPLITS, type Split } from '../eval/jev-benchmark/dataset';
import type { Prices } from '../eval/jev-benchmark/metrics';
import { MOCK_MODEL, MOCK_PROVIDER, MockOracleProvider } from '../eval/jev-benchmark/mock-provider';
import { buildProviderRun, buildReport, mergeReports, type BenchmarkReport } from '../eval/jev-benchmark/report';
import { benchmarkRubricVersion, buildBenchmarkQuestions } from '../eval/jev-benchmark/rubric';
import { runSamples } from '../eval/jev-benchmark/runner';
import {
  assertThresholdsMatch,
  deriveThresholds,
  loadFrozenThresholds,
  writeThresholds,
  type BenchmarkMode,
  type ThresholdIdentity,
} from '../eval/jev-benchmark/thresholds';

const CMS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIVE_PROVIDERS = ['typesafe', 'openrouter', 'llm'] as const;

const USAGE = `Usage:
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
  const reports = values.merge.map((file) => JSON.parse(readFileSync(resolve(file), 'utf8')) as BenchmarkReport);
  try {
    const merged = mergeReports(reports, new Date().toISOString());
    writeJson(resolve(values.out), merged);
    console.log(`Merged ${reports.length} ${merged.mode} reports → ${resolve(values.out)}`);
  } catch (err) {
    fail((err as Error).message);
  }
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

let provider: DecisionProvider;
let model: string;
let mode: BenchmarkMode;
if (providerName === MOCK_PROVIDER) {
  mode = 'mock';
  model = MOCK_MODEL;
  provider = new MockOracleProvider({
    seed: manifest.seed,
    accuracy: manifest.protocol.mock.accuracy,
    failureRate: manifest.protocol.mock.failureRate,
    samples,
  });
} else if ((LIVE_PROVIDERS as readonly string[]).includes(providerName)) {
  mode = 'live';
  const env: DecisionProviderEnv = { ...(process.env as DecisionProviderEnv), DECISION_PROVIDER: providerName };
  const configured = createDecisionProvider(env);
  if (!configured) {
    fail(
      `Provider "${providerName}" is not configured. Set ${
        providerName === 'typesafe' ? 'TYPESAFE_API_KEY' : providerName === 'openrouter' ? 'OPENROUTER_API_KEY' : 'LLM_PROVIDER and its API key'
      }.`,
      2,
    );
  }
  provider = configured.provider;
  model = configured.model;
} else {
  fail(`Unknown provider "${providerName}". Use mock, ${LIVE_PROVIDERS.join(', ')}.`);
}

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
