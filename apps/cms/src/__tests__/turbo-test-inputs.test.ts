import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Turbo hash guard (#865).
 *
 * A CMS test that reads a file from another workspace package only re-runs when
 * that file changes if the file is part of `@lumibase/cms#test`'s hash. Files of
 * a package `@lumibase/cms` depends on reach the hash through `dependsOn:
 * ["^build"]`; a file of any other package (the MCP goldens in
 * `packages/mcp-server`, the CLI fixtures) has to be listed in the `inputs` of
 * `apps/cms/turbo.json`, or a commit that only edits it replays a cached pass.
 *
 * This test finds every relative `…/packages/<dir>/<path>` literal in the CMS
 * test files and fails when it points into a non-dependency package that no
 * `inputs` glob covers.
 */

const CMS_DIR = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = join(CMS_DIR, '..', '..');

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTestFiles(full));
    else if (/\.(test|spec)\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** `apps/cms/turbo.json` is JSONC: drop whole-line `//` comments. */
function readCmsTestInputs(): string[] {
  const raw = readFileSync(join(CMS_DIR, 'turbo.json'), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const config = JSON.parse(raw) as { tasks?: { test?: { inputs?: string[] } } };
  return config.tasks?.test?.inputs ?? [];
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 1;
    } else if (ch === '*') {
      re += '[^/]*';
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function cmsWorkspaceDependencies(): Set<string> {
  const pkg = JSON.parse(readFileSync(join(CMS_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }));
}

function packageNameOf(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf8')) as { name?: string };
    return pkg.name ?? null;
  } catch {
    return null;
  }
}

describe('@lumibase/cms#test turbo inputs', () => {
  it('cover every non-dependency package file a CMS test reads', () => {
    const deps = cmsWorkspaceDependencies();
    const rootInputs = readCmsTestInputs()
      .filter((glob) => glob.startsWith('$TURBO_ROOT$/'))
      .map((glob) => globToRegExp(glob.slice('$TURBO_ROOT$/'.length)));

    const literal = /['"`](?:\.\.\/)+packages\/([^/'"`]+)\/([^'"`$]+)['"`]/g;
    const uncovered: string[] = [];
    const files = [...listTestFiles(join(CMS_DIR, 'src')), ...listTestFiles(join(CMS_DIR, 'eval'))];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(literal)) {
        const [, dir, rest] = match;
        const name = packageNameOf(dir!);
        if (name && deps.has(name)) continue;
        const target = `packages/${dir}/${rest}`;
        if (!rootInputs.some((re) => re.test(target))) {
          uncovered.push(`${relative(CMS_DIR, file)} -> ${target}`);
        }
      }
    }
    expect(uncovered).toEqual([]);
  });

  it('keeps the default inputs', () => {
    expect(readCmsTestInputs()[0]).toBe('$TURBO_DEFAULT$');
  });
});
