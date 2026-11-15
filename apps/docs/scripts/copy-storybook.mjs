// Publish the static Storybook (#755) with the docs site at /storybook/.
//
// Runs at the end of `pnpm --filter @lumibase/docs build`, after prerender, and
// copies `apps/storybook/storybook-static` (built by `pnpm storybook:build`)
// into `dist/storybook/`. Storybook builds with a relative base, so it works
// from any sub-path and needs no rewrite rule: Cloudflare Pages serves
// `/storybook/` → `dist/storybook/index.html` like any other static file.
//
// A docs build without a prior Storybook build still succeeds (local docs work
// should not need Chromium-era tooling) and says so. Release builds set
// STORYBOOK_REQUIRED=1 so a missing Storybook fails instead of shipping a
// dead navbar link.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../../storybook/storybook-static');
const target = path.resolve(here, '../dist/storybook');

export function copyStorybook({ from = source, to = target, required = process.env.STORYBOOK_REQUIRED === '1' } = {}) {
  if (!fs.existsSync(path.join(from, 'index.html'))) {
    const message = `[copy-storybook] no Storybook build at ${from} — run \`pnpm storybook:build\` first.`;
    if (required) throw new Error(message);
    console.warn(`${message} Skipping /storybook/.`);
    return false;
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`[copy-storybook] published Storybook → ${path.relative(process.cwd(), to)}`);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    copyStorybook();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
