import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDataset, samplesFor } from '../dataset';
import { MOCK_MODEL, MockOracleProvider } from '../mock-provider';
import { MOCK_NOTE, ReportMergeError, buildProviderRun, buildReport, mergeReports, parseBenchmarkReport, type BenchmarkReport } from '../report';
import { benchmarkRubricVersion, buildBenchmarkQuestions } from '../rubric';
import { runSamples, type SampleResult } from '../runner';
import {
  LeakageError,
  assertThresholdsMatch,
  deriveThresholds,
  loadFrozenThresholds,
  writeThresholds,
  type ThresholdIdentity,
} from '../thresholds';

const CMS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dataset = loadDataset('v1');
const { manifest } = dataset;
const questions = buildBenchmarkQuestions(manifest);
const rubricVersion = benchmarkRubricVersion(questions);

const identity: ThresholdIdentity = {
  mode: 'mock',
  provider: 'mock',
  model: MOCK_MODEL,
  datasetVersion: manifest.datasetVersion,
  manifestSha256: dataset.manifestSha256,
  rubricVersion,
  protocolVersion: manifest.protocol.version,
};

function mockProvider(split: 'tune' | 'heldout') {
  return new MockOracleProvider({
    seed: manifest.seed,
    accuracy: manifest.protocol.mock.accuracy,
    failureRate: manifest.protocol.mock.failureRate,
    samples: samplesFor(dataset.samples, split),
  });
}

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-bench-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

let tuneResults: SampleResult[];
let heldoutResults: SampleResult[];
beforeAll(async () => {
  tuneResults = await runSamples(mockProvider('tune'), samplesFor(dataset.samples, 'tune'), questions);
  heldoutResults = await runSamples(mockProvider('heldout'), samplesFor(dataset.samples, 'heldout'), questions);
});

describe('mock provider', () => {
  it('is deterministic for a seed and records failures', async () => {
    const again = await runSamples(mockProvider('tune'), samplesFor(dataset.samples, 'tune'), questions);
    expect(again.map((r) => [r.error, r.response?.answers])).toEqual(tuneResults.map((r) => [r.error, r.response?.answers]));
    expect(tuneResults.every((r) => r.split === 'tune')).toBe(true);
  });
});

describe('leakage guard', () => {
  it('derives thresholds from tune only', () => {
    expect(() => deriveThresholds(manifest, identity, [...tuneResults, heldoutResults[0]!])).toThrow(LeakageError);
    expect(() => deriveThresholds(manifest, identity, heldoutResults)).toThrow(LeakageError);
    const file = deriveThresholds(manifest, identity, tuneResults);
    expect(file.derivedFrom).toEqual({ split: 'tune', sampleCounts: { vi: 40, en: 40 } });
    expect(Object.keys(file.thresholds.vi!).sort()).toEqual(['route', 'tag']);
  });

  it('a heldout run cannot write thresholds', () => {
    const path = join(tmp(), 'thresholds.json');
    const file = deriveThresholds(manifest, identity, tuneResults);
    expect(() => writeThresholds(path, file, 'heldout')).toThrow(LeakageError);
    expect(existsSync(path)).toBe(false);
    writeThresholds(path, file, 'tune');
    expect(existsSync(path)).toBe(true);
  });

  it('frozen thresholds only apply to the setup they were derived for', () => {
    const path = join(tmp(), 'thresholds.json');
    writeThresholds(path, deriveThresholds(manifest, identity, tuneResults), 'tune');
    const { file } = loadFrozenThresholds(path);
    expect(() => assertThresholdsMatch(file, identity)).not.toThrow();
    expect(() => assertThresholdsMatch(file, { ...identity, mode: 'live' })).toThrow(/mode/);
    expect(() => assertThresholdsMatch(file, { ...identity, provider: 'typesafe' })).toThrow(/provider/);
    expect(() => assertThresholdsMatch(file, { ...identity, rubricVersion: 'sha256:ffffffffffffffff' })).toThrow(/rubricVersion/);
    expect(() => loadFrozenThresholds(join(tmp(), 'missing.json'))).toThrow(/Run the tune split first/);
  });
});

function reportFor(results: SampleResult[], split: 'tune' | 'heldout', overrides: Partial<ThresholdIdentity> = {}): BenchmarkReport {
  const thresholds = deriveThresholds(manifest, identity, tuneResults);
  const id = { ...identity, ...overrides };
  return buildReport({
    manifest,
    manifestSha256: dataset.manifestSha256,
    rubricVersion,
    mode: id.mode,
    split,
    generatedAt: '2026-10-14T00:00:00.000Z',
    results,
    run: buildProviderRun({
      manifest,
      results,
      provider: id.provider,
      model: id.model,
      thresholds,
      thresholdsSha256: 'test',
      thresholdSource: split === 'tune' ? 'derived-on-this-tune-run' : 'frozen-from-tune',
      prices: null,
    }),
  });
}

describe('reports', () => {
  it('record versions, seed and sample counts, with VI and EN kept apart', () => {
    const report = reportFor(heldoutResults, 'heldout');
    expect(report).toMatchObject({
      schema: 'lumibase.jev-benchmark.report/v1',
      mode: 'mock',
      split: 'heldout',
      dataset: { version: 'v1', manifestSha256: dataset.manifestSha256 },
      rubric: { version: rubricVersion },
      protocol: { version: manifest.protocol.version },
      seed: manifest.seed,
      sampleCounts: { total: 120, vi: 60, en: 60 },
    });
    const run = report.runs[0]!;
    expect(run.sampleCounts).toEqual({ vi: 60, en: 60 });
    expect(run.locales.vi!.calls.calls).toBe(60);
    expect(run.locales.en!.calls.calls).toBe(60);
    expect(run.locales.vi!.actions.tag!.raw.coverage.interval).not.toBeNull();
    expect(Object.keys(run.locales.vi!.slices).sort()).toEqual([...manifest.requiredTags].sort());
  });

  it('flag a mock run and refuse to merge it with a live run', () => {
    const mock = reportFor(heldoutResults, 'heldout');
    expect(mock.mode).toBe('mock');
    expect(mock.notes[0]).toBe(MOCK_NOTE);

    const live = reportFor(heldoutResults, 'heldout', { mode: 'live', provider: 'typesafe', model: 'jev-latest' });
    expect(live.mode).toBe('live');
    expect(live.notes).not.toContain(MOCK_NOTE);
    expect(() => mergeReports([mock, live], 'now')).toThrow(ReportMergeError);
    expect(() => mergeReports([live, mock], 'now')).toThrow(/different modes/);
  });

  it('merge same-mode providers, and refuse different datasets or splits', () => {
    const a = reportFor(heldoutResults, 'heldout');
    const b = reportFor(heldoutResults, 'heldout', { provider: 'mock-b' });
    const merged = mergeReports([a, b], 'now');
    expect(merged.runs.map((r) => r.provider)).toEqual(['mock', 'mock-b']);
    expect(() => mergeReports([a, a], 'now')).toThrow(/more than one report/);
    expect(() => mergeReports([a, { ...b, dataset: { ...b.dataset, manifestSha256: 'other' } }], 'now')).toThrow(/dataset manifest/);
    expect(() => mergeReports([a, reportFor(tuneResults, 'tune', { provider: 'mock-b' })], 'now')).toThrow(/split/);
  });
});

describe('report files given to --merge', () => {
  const withoutMode = (r: BenchmarkReport) => {
    const { mode: _mode, ...rest } = r;
    return rest;
  };

  it('a generated report parses unchanged', () => {
    const report = reportFor(heldoutResults, 'heldout');
    expect(parseBenchmarkReport(JSON.parse(JSON.stringify(report)))).toEqual(report);
  });

  it.each([
    ['without mode', (r: BenchmarkReport) => withoutMode(r)],
    ['with an unknown mode', (r: BenchmarkReport) => ({ ...r, mode: 'x' })],
    ['from another generator', (r: BenchmarkReport) => ({ ...r, generator: 'hand-written' })],
    ['without runs', (r: BenchmarkReport) => ({ ...r, runs: [] })],
    ['that is not an object', () => 'report'],
  ])('a file %s is refused', (_label, mutate) => {
    expect(() => parseBenchmarkReport(mutate(reportFor(heldoutResults, 'heldout')), 'a.json')).toThrow(ReportMergeError);
  });

  it('two hand-edited files without mode no longer pass the mode check together', () => {
    const live = withoutMode(reportFor(heldoutResults, 'heldout', { mode: 'live', provider: 'typesafe', model: 'jev' }));
    const mock = withoutMode(reportFor(heldoutResults, 'heldout'));
    // Unvalidated, both read mode `undefined` and merge as one "mode".
    expect(() => mergeReports([live, mock] as unknown as BenchmarkReport[], 'now')).not.toThrow();
    expect(() => [live, mock].map((r) => parseBenchmarkReport(r))).toThrow(/mode/);
  });
});

describe('bench:jev CLI', () => {
  const tsx = join(CMS_ROOT, 'node_modules/.bin/tsx');
  const script = join(CMS_ROOT, 'scripts/jev-benchmark.ts');
  const run = (...args: string[]) => spawnSync(tsx, [script, ...args], { cwd: CMS_ROOT, encoding: 'utf8' });

  it('refuses a heldout run without frozen thresholds, then never rewrites them', () => {
    const out = tmp();
    const missing = run('--provider', 'mock', '--split', 'heldout', '--out', out);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/No frozen thresholds/);
    expect(existsSync(join(out, 'thresholds.json'))).toBe(false);
    expect(existsSync(join(out, 'report.heldout.json'))).toBe(false);

    expect(run('--', '--provider', 'mock', '--split', 'tune', '--out', out).status).toBe(0);
    const frozen = readFileSync(join(out, 'thresholds.json'), 'utf8');

    expect(run('--provider', 'mock', '--split', 'heldout', '--out', out).status).toBe(0);
    expect(readFileSync(join(out, 'thresholds.json'), 'utf8')).toBe(frozen);
    const report = JSON.parse(readFileSync(join(out, 'report.heldout.json'), 'utf8')) as BenchmarkReport;
    expect(report).toMatchObject({ mode: 'mock', split: 'heldout', sampleCounts: { total: 120 } });
    expect(report.runs[0]!.thresholds.source).toBe('frozen-from-tune');
  }, 60_000);

  it('refuses a tune run that would overwrite thresholds a held-out run was scored with', () => {
    const out = tmp();
    expect(run('--provider', 'mock', '--split', 'tune', '--out', out).status).toBe(0);
    expect(run('--provider', 'mock', '--split', 'heldout', '--out', out).status).toBe(0);
    const frozen = readFileSync(join(out, 'thresholds.json'), 'utf8');
    const again = run('--provider', 'mock', '--split', 'tune', '--out', out);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/frozen/);
    expect(readFileSync(join(out, 'thresholds.json'), 'utf8')).toBe(frozen);
    // A new protocol run is a new directory.
    expect(run('--provider', 'mock', '--split', 'tune', '--out', tmp()).status).toBe(0);
  }, 90_000);

  it('--merge refuses a hand-edited report without mode', () => {
    const out = tmp();
    expect(run('--provider', 'mock', '--split', 'tune', '--out', out).status).toBe(0);
    expect(run('--provider', 'mock', '--split', 'heldout', '--out', out).status).toBe(0);
    const report = JSON.parse(readFileSync(join(out, 'report.heldout.json'), 'utf8')) as Record<string, unknown>;
    delete report['mode'];
    const edited = join(out, 'edited.json');
    writeFileSync(edited, JSON.stringify(report));
    const merged = run('--merge', edited, '--merge', join(out, 'report.heldout.json'), '--out', join(out, 'cmp.json'));
    expect(merged.status).toBe(1);
    expect(merged.stderr).toMatch(/edited\.json is not a bench:jev report: mode/);
    expect(existsSync(join(out, 'cmp.json'))).toBe(false);
  }, 90_000);

  it('a live provider without a key fails before any call', () => {
    const result = spawnSync(tsx, [script, '--provider', 'typesafe', '--split', 'tune', '--out', tmp()], {
      cwd: CMS_ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/TYPESAFE_API_KEY/);
  }, 60_000);
});
