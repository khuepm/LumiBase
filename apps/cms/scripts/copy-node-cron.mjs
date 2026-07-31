#!/usr/bin/env node
/**
 * node-cron@4 evaluates `import.meta.url` at module load (daemon path).
 * Bundling it into CJS via esbuild leaves that URL undefined and crashes
 * Docker/Node startup. Keep it external and ship the package next to
 * dist/serve.cjs so the slim runtime image (which only copies dist/) still
 * resolves `require('node-cron')`.
 */
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cmsRoot = join(here, '..');
const require = createRequire(join(cmsRoot, 'package.json'));

function packageRoot(entryPath) {
  let dir = dirname(entryPath);
  while (dir !== '/' && dir !== '.') {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.name === 'node-cron') return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate node-cron package root from ${entryPath}`);
}

const entry = require.resolve('node-cron');
const src = packageRoot(entry);
const dest = join(cmsRoot, 'dist', 'node_modules', 'node-cron');

mkdirSync(dirname(dest), { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-node-cron] ${src} -> ${dest}`);
