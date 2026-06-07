#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ROOT_PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

const PUBLIC_PACKAGE_ALLOWLIST = [
  'packages/sdk',
  'packages/extension-sdk',
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const planOnly = args.has('--plan');
const notesOnly = args.has('--notes');

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function workspacePackageDirs() {
  const roots = ['apps', 'packages'];
  const dirs = [];

  for (const root of roots) {
    const absoluteRoot = path.join(REPO_ROOT, root);
    if (!(await pathExists(absoluteRoot))) continue;

    for (const entry of await fs.readdir(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relativeDir = path.join(root, entry.name).replaceAll(path.sep, '/');
      if (await pathExists(path.join(REPO_ROOT, relativeDir, 'package.json'))) {
        dirs.push(relativeDir);
      }
    }
  }

  return dirs.sort();
}

function requestedPackageDirs() {
  const requested = process.env.NPM_PUBLISH_PACKAGES
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return requested?.length ? requested : PUBLIC_PACKAGE_ALLOWLIST;
}

function packageVersionFromTag(rootVersion) {
  const tag = process.env.GITHUB_REF_NAME;
  if (!tag) return rootVersion;

  const tagVersion = tag.startsWith('v') ? tag.slice(1) : tag;
  if (tagVersion !== rootVersion) {
    throw new Error(`Release tag ${tag} does not match root package version ${rootVersion}.`);
  }

  return tagVersion;
}

async function copyPackageDir(sourceDir, targetDir) {
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return !['node_modules', '.turbo'].includes(base);
    },
  });
}

function normalizePublishManifest(manifest) {
  const normalized = structuredClone(manifest);
  const publishConfig = normalized.publishConfig ?? {};

  delete normalized.private;
  for (const [key, value] of Object.entries(publishConfig)) {
    if (['access', 'tag', 'registry', 'provenance'].includes(key)) continue;
    normalized[key] = value;
  }
  delete normalized.publishConfig;
  delete normalized.devDependencies;
  delete normalized.scripts;

  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!normalized[section]) continue;

    for (const [name, version] of Object.entries(normalized[section])) {
      if (String(version).startsWith('workspace:')) {
        throw new Error(`${normalized.name} has non-publishable workspace dependency ${name}@${version}.`);
      }
    }
  }

  return normalized;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}.`);
  }
}

async function validatedPackages() {
  const rootPackage = await readJson(ROOT_PACKAGE_PATH);
  const rootVersion = rootPackage.version;
  if (!rootVersion) throw new Error('Root package.json must define a version.');

  const version = packageVersionFromTag(rootVersion);
  const requestedDirs = requestedPackageDirs();
  const workspaceDirs = await workspacePackageDirs();

  for (const requestedDir of requestedDirs) {
    if (!PUBLIC_PACKAGE_ALLOWLIST.includes(requestedDir)) {
      throw new Error(`${requestedDir} is not in the npm publish allowlist.`);
    }
    if (!workspaceDirs.includes(requestedDir)) {
      throw new Error(`${requestedDir} is not a workspace package directory.`);
    }
  }

  for (const workspaceDir of workspaceDirs) {
    const manifest = await readJson(path.join(REPO_ROOT, workspaceDir, 'package.json'));
    if (manifest.private !== true) {
      throw new Error(`${workspaceDir}/package.json must remain private in source control.`);
    }
    if (!requestedDirs.includes(workspaceDir) && PUBLIC_PACKAGE_ALLOWLIST.includes(workspaceDir)) {
      continue;
    }
    if (!requestedDirs.includes(workspaceDir)) {
      continue;
    }
    if (manifest.version !== version) {
      throw new Error(`${manifest.name} version ${manifest.version} does not match release version ${version}.`);
    }
    if (manifest.publishConfig?.access !== 'public') {
      throw new Error(`${manifest.name} must set publishConfig.access to public.`);
    }
  }

  return Promise.all(
    requestedDirs.map(async (dir) => {
      const manifest = await readJson(path.join(REPO_ROOT, dir, 'package.json'));
      return { dir, manifest, version };
    }),
  );
}

function notes(packages) {
  return packages
    .map(({ dir, manifest }) => `- ${manifest.name}@${manifest.version} (${dir})`)
    .join('\n');
}

async function publish(packages) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumibase-npm-publish-'));

  try {
    for (const { dir, manifest } of packages) {
      const sourceDir = path.join(REPO_ROOT, dir);
      const targetDir = path.join(tempRoot, path.basename(dir));
      await copyPackageDir(sourceDir, targetDir);
      await fs.writeFile(
        path.join(targetDir, 'package.json'),
        `${JSON.stringify(normalizePublishManifest(manifest), null, 2)}\n`,
      );

      const publishArgs = ['publish', targetDir, '--access', 'public', '--provenance'];
      if (dryRun) publishArgs.push('--dry-run');
      run('npm', publishArgs);
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const packages = await validatedPackages();

if (notesOnly) {
  console.log(notes(packages));
} else if (planOnly) {
  console.log('Allowlisted npm packages selected for release:');
  console.log(notes(packages));
} else {
  await publish(packages);
}
