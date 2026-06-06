#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const CHECK_MODE = process.argv.includes('--check');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ROOT_PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');

const APP_PACKAGE_PATHS = [
  'apps/cms/package.json',
  'apps/studio/package.json',
  'apps/docs/package.json',
  'apps/landing/package.json',
  'apps/marketplace/package.json',
  'apps/consumer/package.json',
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
  const packagePaths = [...APP_PACKAGE_PATHS];
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
