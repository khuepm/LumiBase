import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decisionRubricVersion } from '../../../src/services/decision-governance';
import { DATASETS_ROOT, LOCALES, SPLITS, loadDataset, samplesFor } from '../dataset';
import { benchmarkRubricVersion, buildBenchmarkQuestions, requestFor } from '../rubric';

const dataset = loadDataset('v1');
const { manifest, samples } = dataset;

describe('dataset v1 manifest', () => {
  it('has at least 200 samples, at least 100 per locale, about 40% tune', () => {
    expect(samples.length).toBeGreaterThanOrEqual(200);
    for (const locale of LOCALES) {
      const all = samples.filter((s) => s.locale === locale);
      expect(all.length).toBeGreaterThanOrEqual(100);
      const tuneShare = samplesFor(samples, 'tune', locale).length / all.length;
      expect(tuneShare).toBeGreaterThanOrEqual(0.35);
      expect(tuneShare).toBeLessThanOrEqual(0.45);
    }
  });

  it('counts match the manifest per file', () => {
    for (const entry of Object.values(manifest.files)) {
      expect(samplesFor(samples, entry.split, entry.locale)).toHaveLength(entry.count);
    }
  });

  it('every required tag appears in every locale and split', () => {
    for (const locale of LOCALES) {
      for (const split of SPLITS) {
        const tags = new Set(samplesFor(samples, split, locale).flatMap((s) => s.tags));
        for (const tag of manifest.requiredTags) expect(tags, `${locale}/${split} lacks "${tag}"`).toContain(tag);
      }
    }
  });

  it('every taxonomy option is a gold label in every locale and split', () => {
    const spec = manifest.labelSchema.category!;
    expect(spec.type).toBe('choice');
    if (spec.type !== 'choice') return;
    for (const locale of LOCALES) {
      for (const split of SPLITS) {
        const golds = new Set(samplesFor(samples, split, locale).map((s) => s.labels.category));
        for (const option of spec.options) expect(golds, `${locale}/${split} lacks "${option}"`).toContain(option);
      }
    }
  });

  it('tags agree with labels', () => {
    for (const s of samples) {
      expect(s.tags.includes('needs-review'), s.id).toBe(s.labels.needs_review === true);
      if (s.tags.includes('out-of-taxonomy')) expect(s.labels.category, s.id).toBe('other');
      if (s.tags.includes('thin-content')) expect(s.labels.category, s.id).toBe('unknown');
      if (s.tags.includes('prompt-injection')) expect(s.labels.needs_review, s.id).toBe(true);
    }
  });
});

describe('leakage between splits', () => {
  it('tune and heldout ids are disjoint', () => {
    const tune = new Set(samplesFor(samples, 'tune').map((s) => s.id));
    const heldout = samplesFor(samples, 'heldout').map((s) => s.id);
    expect(heldout.filter((id) => tune.has(id))).toEqual([]);
  });

  it('no content appears twice, inside or across splits', () => {
    const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim();
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const s of samples) {
      const key = normalise(`${s.fields.title}\n${s.fields.body}`);
      const previous = seen.get(key);
      if (previous) duplicates.push(`${previous} = ${s.id}`);
      seen.set(key, s.id);
    }
    expect(duplicates).toEqual([]);
  });
});

describe('rubric', () => {
  const questions = buildBenchmarkQuestions(manifest);

  it('is built from the J05 presets and frozen by the manifest', () => {
    expect(Object.keys(questions).sort()).toEqual(['category', 'needs_review']);
    expect(benchmarkRubricVersion(questions)).toBe(manifest.profile.rubricVersion);
  });

  it('uses the same fingerprint as the decision audit', async () => {
    const request = requestFor(samples[0]!, questions);
    expect(benchmarkRubricVersion(questions)).toBe(await decisionRubricVersion(request));
  });

  it('puts content only in state, so injected text cannot change the questions', () => {
    const injected = samples.filter((s) => s.tags.includes('prompt-injection'));
    expect(injected.length).toBeGreaterThan(0);
    for (const s of injected) {
      const request = requestFor(s, questions);
      expect(request.state).toEqual(s.fields);
      expect(request.questions).toBe(questions);
    }
  });
});

describe('loadDataset integrity', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function copy(): string {
    const root = mkdtempSync(join(tmpdir(), 'jev-dataset-'));
    dirs.push(root);
    cpSync(join(DATASETS_ROOT, 'v1'), join(root, 'v1'), { recursive: true });
    return root;
  }

  it('refuses a split whose content changed without a new version', () => {
    const root = copy();
    const file = join(root, 'v1', 'heldout.en.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"category":"news"', '"category":"opinion"'));
    expect(() => loadDataset('v1', root)).toThrow(/sha256/);
  });

  it('refuses a manifest whose declared version is different', () => {
    expect(() => loadDataset('v2', copy())).toThrow();
  });
});
