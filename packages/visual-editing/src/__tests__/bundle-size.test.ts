// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * V03 #681 acceptance: the overlay ships ≤ 15 kB gzip. Bundles the public
 * entry the way a frontend bundler would (ESM, minified, tree-shaken, zod
 * included) and measures it.
 */
const BUDGET_BYTES = 15 * 1024;

describe('bundle size', () => {
  it(`index bundle is ≤ ${BUDGET_BYTES} bytes gzip`, async () => {
    const result = await build({
      entryPoints: [resolve(__dirname, '../index.ts')],
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      metafile: false,
      logLevel: 'silent',
    });
    const code = result.outputFiles[0]!.contents;
    const gzipped = gzipSync(code).length;
    expect(gzipped).toBeLessThanOrEqual(BUDGET_BYTES);
    // Guard against an accidental `eval`/`Function` in the shipped code.
    const text = new TextDecoder().decode(code);
    expect(text).not.toMatch(/\beval\(/);
  }, 30_000);
});
