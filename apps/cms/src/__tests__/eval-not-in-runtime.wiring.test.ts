import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Jev benchmark harness (`apps/cms/eval/`, J06 #513) is development
 * tooling: synthetic datasets, a mock oracle, threshold derivation. It must
 * never be imported by the CMS runtime. `verify:worker-bundle` only proves the
 * dataset module (its bundle marker) stays out of the Workers bundle; an
 * import of `metrics.ts` or `runner.ts` would not carry the marker. This
 * source scan closes that gap for every runtime file under `src/`.
 */
const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx|mts|cts)$/.test(name) && !/\.(test|spec)\.[cm]?tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Module specifiers in static imports, dynamic imports and re-exports. */
export function evalImports(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const spec = match[1]!;
    if (/(^|\/)eval(\/|$)/.test(spec) || spec.includes('jev-benchmark') || spec.includes('jev-pilot')) specifiers.push(spec);
  }
  return specifiers;
}

describe('the benchmark harness stays out of the CMS runtime (J06)', () => {
  it('no runtime file under apps/cms/src imports from apps/cms/eval', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      evalImports(readFileSync(file, 'utf8')).map((spec) => `${relative(SRC, file).split(sep).join('/')}: ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the scan catches the import forms it is meant to', () => {
    expect(evalImports("import { x } from '../../eval/jev-benchmark/metrics';")).toHaveLength(1);
    expect(evalImports("const m = await import('../eval/jev-benchmark/runner');")).toHaveLength(1);
    expect(evalImports("export * from '../eval/jev-pilot/report';")).toHaveLength(1);
    expect(evalImports("import { evaluate } from './evaluator';")).toEqual([]);
  });
});
