/**
 * Jev benchmark dataset (J06, #513): manifest + JSONL splits.
 *
 * Every sample is hand-authored synthetic editorial content written for this
 * benchmark. None of it is customer or user data, and the harness never reads
 * content from a database.
 *
 * The loader is strict on purpose: a file whose hash or line count no longer
 * matches the manifest is a different dataset, and a report built on it would
 * claim a version it does not have.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVIEW_PRESETS } from '@lumibase/contracts/schemas';
import { z } from 'zod';

/**
 * Written into every report. `scripts/check-worker-bundle.mjs` fails when it
 * shows up in the Cloudflare bundle, which proves the benchmark (and its
 * dataset) stays out of the Worker.
 */
export const BENCHMARK_BUNDLE_MARKER = 'lumibase-jev-benchmark-eval';

export const LOCALES = ['vi', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const SPLITS = ['tune', 'heldout'] as const;
export type Split = (typeof SPLITS)[number];

export const DATASETS_ROOT = fileURLToPath(new URL('./datasets/', import.meta.url).href);

const labelSpecSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    options: z.array(z.string().min(1)).min(2),
    /** Options that mean "the model did not decide" (counted as abstention). */
    abstain: z.array(z.string().min(1)),
  }).strict(),
  z.object({ type: z.literal('noul') }).strict(),
]);
export type LabelSpec = z.infer<typeof labelSpecSchema>;

const actionSchema = z.object({
  question: z.string().min(1),
  /** Minimum selective precision (accuracy on the decided samples) a threshold must reach on `tune`. */
  targetPrecision: z.number().gt(0).max(1),
  /** Candidate thresholds, scanned in ascending order. */
  grid: z.array(z.number().min(0).max(1)).min(1),
}).strict();

export const manifestSchema = z.object({
  schema: z.literal('lumibase.jev-benchmark.dataset/v1'),
  datasetVersion: z.string().min(1),
  createdAt: z.string().min(1),
  provenance: z.string().min(1),
  seed: z.number().int(),
  locales: z.array(z.enum(LOCALES)).min(1),
  fields: z.array(z.string().min(1)).min(1),
  labelSchema: z.record(z.string(), labelSpecSchema),
  annotationGuidelines: z.record(z.string(), z.string()),
  /** Tag vocabulary. Each locale and each split must contain every tag. */
  requiredTags: z.array(z.string().min(1)).min(1),
  profile: z.object({
    presetSource: z.string().min(1),
    presets: z.array(z.object({
      preset: z.enum(REVIEW_PRESETS),
      options: z.record(z.string(), z.unknown()).optional(),
      questions: z.array(z.string().min(1)).min(1),
    }).strict()).min(1),
    /** Expected `decisionRubricVersion` of the questions the presets build. */
    rubricVersion: z.string().regex(/^sha256:[0-9a-f]{16}$/),
  }).strict(),
  protocol: z.object({
    version: z.string().min(1),
    thresholdSplit: z.literal('tune'),
    evaluationSplit: z.literal('heldout'),
    actions: z.record(z.string(), actionSchema),
    minCoveredSamples: z.number().int().min(1),
    eceBins: z.number().int().min(2),
    interval: z.literal('wilson-95'),
    percentile: z.literal('nearest-rank'),
    mock: z.object({
      accuracy: z.number().min(0).max(1),
      failureRate: z.number().min(0).max(1),
    }).strict(),
  }).strict(),
  files: z.record(z.string(), z.object({
    locale: z.enum(LOCALES),
    split: z.enum(SPLITS),
    count: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()),
}).strict();
export type DatasetManifest = z.infer<typeof manifestSchema>;

const sampleSchema = z.object({
  id: z.string().regex(/^[a-z]{2}-\d{3}$/),
  locale: z.enum(LOCALES),
  split: z.enum(SPLITS),
  fields: z.record(z.string(), z.string()),
  labels: z.record(z.string(), z.union([z.string(), z.boolean()])),
  tags: z.array(z.string().min(1)).min(1),
}).strict();
export type BenchmarkSample = z.infer<typeof sampleSchema>;

export interface LoadedDataset {
  manifest: DatasetManifest;
  /** sha256 of the manifest file bytes; recorded in every report and threshold file. */
  manifestSha256: string;
  samples: BenchmarkSample[];
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Checks one parsed sample against the manifest's fields, labels and tags. Throws on the first problem. */
export function validateSample(sample: BenchmarkSample, manifest: DatasetManifest, where: string): void {
  const fieldKeys = Object.keys(sample.fields).sort();
  const expectedFields = [...manifest.fields].sort();
  if (fieldKeys.join(',') !== expectedFields.join(',')) {
    throw new Error(`${where}: fields must be exactly ${expectedFields.join(', ')}`);
  }
  for (const [question, spec] of Object.entries(manifest.labelSchema)) {
    if (!Object.hasOwn(sample.labels, question)) throw new Error(`${where}: missing label "${question}"`);
    const value = sample.labels[question];
    if (spec.type === 'noul' && typeof value !== 'boolean') throw new Error(`${where}: "${question}" must be a boolean`);
    if (spec.type === 'choice' && (typeof value !== 'string' || !spec.options.includes(value))) {
      throw new Error(`${where}: "${question}" must be one of ${spec.options.join(', ')}`);
    }
  }
  for (const key of Object.keys(sample.labels)) {
    if (!Object.hasOwn(manifest.labelSchema, key)) throw new Error(`${where}: unknown label "${key}"`);
  }
  for (const tag of sample.tags) {
    if (!manifest.requiredTags.includes(tag)) throw new Error(`${where}: unknown tag "${tag}"`);
  }
}

/** Parses JSONL text into validated samples. Pure: no file access. */
export function parseSplit(
  text: string,
  manifest: DatasetManifest,
  file: { name: string; locale: Locale; split: Split },
): BenchmarkSample[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  return lines.map((line, index) => {
    const where = `${file.name}:${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    const parsed = sampleSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${where}: ${parsed.error.issues[0]?.message ?? 'invalid sample'}`);
    const sample = parsed.data;
    if (sample.locale !== file.locale || sample.split !== file.split) {
      throw new Error(`${where}: sample says ${sample.locale}/${sample.split}, file is ${file.locale}/${file.split}`);
    }
    validateSample(sample, manifest, where);
    return sample;
  });
}

/**
 * Loads `datasets/<version>/`: validates the manifest, verifies each split's
 * sha256 and line count, and parses every sample. Throws on any mismatch.
 */
export function loadDataset(version: string, root: string = DATASETS_ROOT): LoadedDataset {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(version)) throw new Error(`Invalid dataset version "${version}"`);
  const dir = join(root, version);
  const manifestText = readFileSync(join(dir, 'manifest.json'), 'utf8');
  const manifest = manifestSchema.parse(JSON.parse(manifestText));
  if (manifest.datasetVersion !== version) {
    throw new Error(`manifest.json declares datasetVersion "${manifest.datasetVersion}", expected "${version}"`);
  }

  const samples: BenchmarkSample[] = [];
  const seen = new Set<string>();
  for (const [name, entry] of Object.entries(manifest.files)) {
    if (!/^[a-z]+\.[a-z]{2}\.jsonl$/.test(name)) throw new Error(`Unexpected dataset file name "${name}"`);
    const bytes = readFileSync(join(dir, name));
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256) {
      throw new Error(`${name}: sha256 is ${actual}, manifest says ${entry.sha256}. Bump the dataset version instead of editing it.`);
    }
    const parsed = parseSplit(new TextDecoder().decode(bytes), manifest, { name, locale: entry.locale, split: entry.split });
    if (parsed.length !== entry.count) throw new Error(`${name}: ${parsed.length} samples, manifest says ${entry.count}`);
    for (const sample of parsed) {
      if (seen.has(sample.id)) throw new Error(`${name}: duplicate sample id "${sample.id}"`);
      seen.add(sample.id);
      samples.push(sample);
    }
  }
  return { manifest, manifestSha256: sha256Hex(manifestText), samples };
}

export function samplesFor(samples: readonly BenchmarkSample[], split: Split, locale?: Locale): BenchmarkSample[] {
  return samples.filter((sample) => sample.split === split && (locale === undefined || sample.locale === locale));
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}
