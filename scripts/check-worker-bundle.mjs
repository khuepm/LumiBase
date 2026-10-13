/**
 * Worker-bundle composition tripwire.
 *
 * `packages/runtime` exposes Cloudflare-safe code at its root and the Docker
 * adapters behind `@lumibase/runtime/docker`. If anything on the Worker path
 * imports the Docker subtree again — directly, or by re-exporting it from the
 * package root — the Node-only dependency graph lands back in the Worker.
 *
 * That is not a size problem, it is an outage. BullMQ 6's Postgres
 * `sql-loader.js` resolves its own directory at MODULE TOP LEVEL and throws
 * `Could not determine sql-loader directory path` when there is no `__dirname`
 * and no `file:///` stack frame — exactly a bundled Worker. The Worker then
 * fails to start and Cloudflare rejects the deploy with validation error 10021.
 * It went unnoticed because `wrangler deploy --dry-run` bundles the code without
 * ever instantiating it, so `pnpm build` was green the whole time.
 *
 * This check greps the built bundle for markers that must not appear. It is the
 * cheap half of the fence; `verify-worker-startup.mjs` is the half that proves
 * the Worker actually boots.
 *
 * Usage: pnpm --filter @lumibase/cms build && node scripts/check-worker-bundle.mjs
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const bundlePath = path.join(process.cwd(), 'apps/cms/dist/cloudflare.js');

/**
 * Markers that must be absent, with the reason each one matters. Keep the
 * reasons — a future reader needs to know whether a hit is fatal or merely fat.
 */
const forbidden = [
  {
    marker: 'Could not determine sql-loader directory path',
    why: "BullMQ's Postgres sql-loader — throws at module top level under Workers (the actual outage)",
  },
  { marker: 'bullmq', why: 'BullMQ queue adapter — Docker-only, and the source of the startup throw' },
  { marker: 'ioredis', why: 'Redis client — Docker-only; also reached via the leader lock' },
  { marker: '@aws-sdk/client-s3', why: 'S3 storage adapter — Docker-only (Workers use R2)' },
  { marker: 'node_modules/meilisearch', why: 'MeiliSearch SDK — Docker-only (Workers use the fetch adapter)' },
];

let bundle;
try {
  bundle = await readFile(bundlePath, 'utf8');
} catch {
  console.error(`Worker bundle check failed:
- ${path.relative(process.cwd(), bundlePath)} not found.
  Build it first: pnpm --filter @lumibase/cms build`);
  process.exit(1);
}

// A bundle that parses as suspiciously small means the build shape changed and
// this check stopped checking anything meaningful.
const { size } = await stat(bundlePath);
if (size < 1_000_000) {
  console.error(`Worker bundle check failed:
- bundle is only ${size} bytes, which is far below the expected size.
  The build output shape probably changed; this guard cannot vouch for it.`);
  process.exit(1);
}

const hits = forbidden
  .map(({ marker, why }) => ({ marker, why, count: bundle.split(marker).length - 1 }))
  .filter((h) => h.count > 0);

if (hits.length > 0) {
  console.error('Worker bundle check failed — Docker-only code is in the Cloudflare bundle:\n');
  for (const { marker, why, count } of hits) {
    console.error(`- ${marker} (${count} occurrence${count === 1 ? '' : 's'})`);
    console.error(`    ${why}`);
  }
  console.error(`
Something on the Worker path imports the Docker adapters again. Check:
  - packages/runtime/src/index.ts must not re-export ./adapters/docker,
    ./factory (createRuntime) or ./leader-lock — see the note at its top.
  - apps/cms/src/middleware/runtime.ts must import only createCloudflareRuntime
    statically; the docker branch goes through await import().
  - apps/cms/wrangler.toml aliases @lumibase/runtime/docker to a stub, because a
    dynamic import is still a static edge for the bundler.
Import types with \`import type\` where you only need the shape — those are erased.`);
  process.exit(1);
}

console.log(
  `Worker bundle OK: ${(size / 1024 / 1024).toFixed(2)} MB, none of the ${forbidden.length} Docker-only markers present.`,
);
