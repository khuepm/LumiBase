#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRootVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readGitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

const metadata = {
  LUMIBASE_VERSION: process.env.LUMIBASE_VERSION || readRootVersion(),
  LUMIBASE_GIT_SHA: process.env.LUMIBASE_GIT_SHA || readGitSha(),
  LUMIBASE_BUILD_TIME: process.env.LUMIBASE_BUILD_TIME || new Date().toISOString(),
  LUMIBASE_RELEASE_CHANNEL: process.env.LUMIBASE_RELEASE_CHANNEL || process.env.NODE_ENV || 'development',
};

const env = {
  ...process.env,
  ...metadata,
  VITE_LUMIBASE_VERSION: process.env.VITE_LUMIBASE_VERSION || metadata.LUMIBASE_VERSION,
  VITE_LUMIBASE_GIT_SHA: process.env.VITE_LUMIBASE_GIT_SHA || metadata.LUMIBASE_GIT_SHA,
  VITE_LUMIBASE_BUILD_TIME: process.env.VITE_LUMIBASE_BUILD_TIME || metadata.LUMIBASE_BUILD_TIME,
};

const [command, ...rawArgs] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/with-build-metadata.mjs <command> [...args]');
  process.exit(1);
}

const args = [...rawArgs];
if (args[0] === '--') {
  args.shift();
}
if (command === 'wrangler' && args[0] === 'deploy') {
  for (const [key, value] of Object.entries(metadata)) {
    args.push('--var', `${key}:${value}`);
  }
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
