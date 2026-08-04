#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const CHECK_MODE = process.argv.includes('--check');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ROOT_PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

// apps/marketplace is intentionally omitted: it is a git submodule
// (private lumibase-ai/marketplace) that is versioned and released
// independently from the main repo, so it must NOT be synced to the root
// version. It is also excluded from the pnpm workspace (see pnpm-workspace.yaml).
const APP_PACKAGE_PATHS = [
  'apps/cms/package.json',
  'apps/studio/package.json',
  'apps/shell/package.json',
  'apps/docs/package.json',
  'apps/landing/package.json',
  'apps/consumer/package.json',
];

// The Tauri shell carries the release version in three files that are not
// package.json, so the package sweep above cannot see them. tauri.conf.json is
// the value the desktop auto-updater compares against, which is why drifting
// here is not cosmetic — v0.24.1 exists solely to repair that drift after
// v0.24.0 shipped with stale metadata. Syncing them here rather than by hand
// is what keeps that from recurring.
const EXTRA_VERSION_FILES = [
  {
    path: 'apps/shell/src-tauri/tauri.conf.json',
    // Top-level "version" — the first such key in the file.
    pattern: /^(\s*"version"\s*:\s*")([^"]*)(")/m,
  },
  {
    path: 'apps/shell/src-tauri/Cargo.toml',
    // [package] version — the first bare `version = "…"` at column 0.
    pattern: /^(version\s*=\s*")([^"]*)(")/m,
  },
  {
    path: 'apps/shell/src-tauri/Cargo.lock',
    // Only the lumibase-shell entry; every other [[package]] block pins a
    // third-party crate whose version must not be touched.
    pattern: /^(name = "lumibase-shell"\nversion = ")([^"]*)(")/m,
  },
];

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return { content, data: JSON.parse(content) };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function packagePaths() {
  // Skip hardcoded app paths that no longer resolve to a file — e.g. once an
  // app is extracted into a git submodule its package.json lives inside the
  // (uninitialized in CI) submodule, so `apps/<name>/package.json` is absent.
  const appPackagePaths = [];
  for (const relativePackagePath of APP_PACKAGE_PATHS) {
    if (await pathExists(path.join(REPO_ROOT, relativePackagePath))) {
      appPackagePaths.push(relativePackagePath);
    }
  }

  const packagePaths = [...appPackagePaths];
  const packagesRoot = path.join(REPO_ROOT, 'packages');

  if (await pathExists(packagesRoot)) {
    const entries = await fs.readdir(packagesRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const packagePath = path.join('packages', entry.name, 'package.json');
        if (await pathExists(path.join(REPO_ROOT, packagePath))) {
          packagePaths.push(packagePath);
        }
      }
    }
  }

  return packagePaths.sort();
}

function withSyncedVersion(content, version) {
  if (/^\s*"version"\s*:/m.test(content)) {
    return content.replace(
      /^(\s*)"version"\s*:\s*"[^"]*"(\s*,?)/m,
      `$1"version": "${version}"$2`,
    );
  }

  return content.replace(
    /^(\s*)"name"\s*:\s*"[^"]*"\s*,/m,
    `$&\n$1"version": "${version}",`,
  );
}

const { data: rootPackage } = await readJson(ROOT_PACKAGE_PATH);
const rootVersion = rootPackage.version;

if (!rootVersion) {
  console.error('Root package.json must define a version.');
  process.exit(1);
}

const mismatches = [];
const synced = [];

for (const relativePackagePath of await packagePaths()) {
  const absolutePackagePath = path.join(REPO_ROOT, relativePackagePath);
  // Skip packages whose files aren't present — e.g. a submodule (apps/marketplace)
  // that wasn't checked out in this environment. Its version is managed in its
  // own repo, so there's nothing to sync here.
  if (!(await pathExists(absolutePackagePath))) {
    continue;
  }
  const { content, data } = await readJson(absolutePackagePath);

  if (data.version === rootVersion) {
    continue;
  }

  mismatches.push({ packagePath: relativePackagePath, version: data.version });

  if (!CHECK_MODE) {
    await fs.writeFile(absolutePackagePath, withSyncedVersion(content, rootVersion));
    synced.push(relativePackagePath);
  }
}

for (const { path: relativePath, pattern } of EXTRA_VERSION_FILES) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  if (!(await pathExists(absolutePath))) {
    continue;
  }

  const content = await fs.readFile(absolutePath, 'utf8');
  const match = content.match(pattern);

  if (!match) {
    // A file that no longer exposes the version where we expect it would sync
    // silently and ship stale metadata, which is the exact failure this list
    // exists to prevent — so treat it as a mismatch rather than skipping.
    mismatches.push({ packagePath: relativePath, version: '(version field not found)' });
    continue;
  }

  if (match[2] === rootVersion) {
    continue;
  }

  mismatches.push({ packagePath: relativePath, version: match[2] });

  if (!CHECK_MODE) {
    await fs.writeFile(absolutePath, content.replace(pattern, `$1${rootVersion}$3`));
    synced.push(relativePath);
  }
}

if (CHECK_MODE && mismatches.length > 0) {
  console.error(`Version mismatch: expected ${rootVersion} from root package.json.`);
  for (const mismatch of mismatches) {
    console.error(`- ${mismatch.packagePath}: ${mismatch.version ?? '(missing)'}`);
  }
  process.exit(1);
}

if (synced.length > 0) {
  console.log(`Synced ${synced.length} package version(s) to ${rootVersion}:`);
  for (const packagePath of synced) {
    console.log(`- ${packagePath}`);
  }
} else {
  console.log(`All package versions are already synced to ${rootVersion}.`);
}
