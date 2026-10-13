/**
 * Worker-build stand-in for `@lumibase/runtime/docker`.
 *
 * `withRuntime` reaches the Docker adapters through `await import()` on a branch
 * that only executes when `LUMIBASE_RUNTIME` is `docker` — which cannot happen
 * inside a Worker. But a dynamic import is still a static edge as far as the
 * bundler is concerned: esbuild inlines the target, so BullMQ, ioredis,
 * `@aws-sdk/client-s3` and MeiliSearch all shipped in the Worker anyway (~8 MB),
 * and BullMQ's Postgres `sql-loader` runs `getDirname()` at module top level and
 * throws under Workers.
 *
 * `wrangler.toml` aliases the subpath to this file so the Docker subtree is
 * absent from the Worker bundle entirely. If the unreachable branch ever does
 * run, it fails with a description of the real misconfiguration instead of an
 * opaque module error.
 */
import type { RuntimeContext } from '@lumibase/runtime';

export function createDockerRuntime(): RuntimeContext {
  throw new Error(
    'LUMIBASE_RUNTIME=docker is not supported on Cloudflare Workers: the Docker ' +
      'adapters (Redis, BullMQ, S3, MeiliSearch) are excluded from the Worker ' +
      'bundle by design. Set LUMIBASE_RUNTIME=cloudflare for Worker deployments, ' +
      'or run the Node entry point (src/serve.ts) for Docker deployments.',
  );
}
