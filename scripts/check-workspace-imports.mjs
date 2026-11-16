/**
 * Workspace-import tripwire.
 *
 * Everything under `apps/` and `packages/` must build from this repository
 * alone. The `@lumibase/*` scope is where that could quietly stop being true:
 * a module that imports an `@lumibase/…` package which is not a member of this
 * workspace type-checks on a machine that happens to have it linked and breaks
 * for everyone else.
 *
 * Two rules, both about the `@lumibase/` scope:
 *   1. every `@lumibase/<name>` import specifier names a workspace package;
 *   2. every `@lumibase/<name>` dependency in a workspace manifest uses the
 *      `workspace:` protocol.
 *
 * This is what lets a deployment wrap the CMS from outside (see
 * docs/en/architecture/platform-extension-points.md) while the dependency
 * arrow keeps pointing one way: outside code imports this repository, never
 * the reverse.
 *
 * Usage: node scripts/check-workspace-imports.mjs
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', '.wrangler', '.next', 'target', 'coverage']);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// `from '@lumibase/x'`, `import('@lumibase/x')`, `require('@lumibase/x')`, `import '@lumibase/x'`.
const SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)(['"])(@lumibase\/[a-z0-9._-]+)(?:\/[^'"]*)?\1/g;

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Directories pnpm-workspace.yaml excludes (`- "!apps/x"`); they build on their own. */
async function excludedDirs(repoRoot) {
  const file = path.join(repoRoot, 'pnpm-workspace.yaml');
  if (!(await exists(file))) return new Set();
  const excluded = [...(await readFile(file, 'utf8')).matchAll(/^\s*-\s*["']?!([^"'\s]+)["']?\s*$/gm)];
  return new Set(excluded.map((match) => path.join(repoRoot, match[1])));
}

/** Workspace members: every direct child of apps/ and packages/ with a manifest. */
async function workspaceMembers(repoRoot) {
  const members = [];
  const excluded = await excludedDirs(repoRoot);
  for (const root of ROOTS) {
    if (!(await exists(path.join(repoRoot, root)))) continue;
    for (const entry of await readdir(path.join(repoRoot, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(repoRoot, root, entry.name);
      if (excluded.has(dir)) continue;
      const manifestPath = path.join(dir, 'package.json');
      if (!(await exists(manifestPath))) continue; // e.g. a submodule that is not checked out
      members.push({ dir, manifest: JSON.parse(await readFile(manifestPath, 'utf8')) });
    }
  }
  return members;
}

async function* sourceFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(path.join(dir, entry.name));
    } else if (SOURCE.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

/** @returns {{ problems: string[], files: number }} */
export async function checkWorkspaceImports(repoRoot = process.cwd()) {
  const members = await workspaceMembers(repoRoot);
  const names = new Set(members.map((m) => m.manifest.name).filter(Boolean));
  const problems = [];
  let files = 0;

  for (const { dir, manifest } of members) {
    const rel = path.relative(repoRoot, dir);
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (!dep.startsWith('@lumibase/')) continue;
        if (!names.has(dep)) {
          problems.push(`${rel}/package.json: ${field}["${dep}"] is not a package in this workspace`);
        } else if (!String(range).startsWith('workspace:')) {
          problems.push(`${rel}/package.json: ${field}["${dep}"] must use the workspace: protocol (found "${range}")`);
        }
      }
    }
    for await (const file of sourceFiles(dir)) {
      files += 1;
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(SPECIFIER)) {
        if (!names.has(match[2])) {
          const line = source.slice(0, match.index).split('\n').length;
          problems.push(`${path.relative(repoRoot, file)}:${line}: imports "${match[2]}", which is not a package in this workspace`);
        }
      }
    }
  }
  return { problems, files };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, files } = await checkWorkspaceImports();
  if (problems.length > 0) {
    console.error(`Workspace import check failed:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`Workspace imports OK: ${files} source files, every @lumibase/* reference resolves inside this workspace.`);
}
