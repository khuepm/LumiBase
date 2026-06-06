import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { assertNoAdminPathEnv } from './src/lib/build-assertions';

// Fail the build (or dev server startup) if any env var starts with
// `VITE_ADMIN_PATH`. Vite would otherwise inline such a var into the
// client bundle, leaking the custom Admin Path that the "Hide Login"
// pattern depends on (admin-setup-wizard requirements §4.7;
// design.md §7.3 — Secret handling).
assertNoAdminPathEnv();

const repoRoot = path.resolve(__dirname, '../..');
const cmsProxyTarget = process.env.LUMIBASE_CMS_PROXY_TARGET ?? 'http://127.0.0.1:1989';

function readRootVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readGitSha(): string {
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

const viteBuildMetadata = {
  VITE_LUMIBASE_VERSION: process.env.VITE_LUMIBASE_VERSION || process.env.LUMIBASE_VERSION || readRootVersion(),
  VITE_LUMIBASE_GIT_SHA: process.env.VITE_LUMIBASE_GIT_SHA || process.env.LUMIBASE_GIT_SHA || readGitSha(),
  VITE_LUMIBASE_BUILD_TIME: process.env.VITE_LUMIBASE_BUILD_TIME || process.env.LUMIBASE_BUILD_TIME || new Date().toISOString(),
};

Object.assign(process.env, viteBuildMetadata);

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_LUMIBASE_VERSION': JSON.stringify(viteBuildMetadata.VITE_LUMIBASE_VERSION),
    'import.meta.env.VITE_LUMIBASE_GIT_SHA': JSON.stringify(viteBuildMetadata.VITE_LUMIBASE_GIT_SHA),
    'import.meta.env.VITE_LUMIBASE_BUILD_TIME': JSON.stringify(viteBuildMetadata.VITE_LUMIBASE_BUILD_TIME),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 2026,
    proxy: {
      // Proxy API calls to local wrangler so the SPA can use same-origin cookies.
      '/api': {
        target: cmsProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
