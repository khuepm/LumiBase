/**
 * Cloudflare Workers entrypoint.
 *
 * This file is used as `main` in wrangler.toml for Cloudflare deployments.
 * It exports the Worker's `ExportedHandler` (HTTP `fetch` + scheduled cron
 * `scheduled`) AND the Durable Object classes that Wrangler needs to register
 * (via class_name in wrangler.toml).
 *
 * IMPORTANT: Do NOT import this file from serve.ts or any Node.js code path.
 * `site-room.ts` imports `cloudflare:workers` which is unavailable in Node.js
 * and will crash the Docker build.
 *
 * Build targets:
 *   - Cloudflare Workers: wrangler deploy (uses this file via wrangler.toml)
 *   - Docker / Node.js:   esbuild src/serve.ts → dist/serve.js (index.ts, no SiteRoom)
 */

import * as Sentry from '@sentry/cloudflare';
import { createDb } from '@lumibase/database';
import app from './index';
import type { Bindings } from './env';
import { runScheduledRotation } from './modules/audit/scheduled';
import { resolveSentryOptions } from './observability/sentry';

// ── Default export: ExportedHandler (fetch + scheduled) ─────────────────────
//
// Previously this file did `export { default } from './index'`, exporting the
// Hono `app` directly — which only carries a `fetch` handler. Cloudflare Cron
// Triggers invoke a Worker's `scheduled(controller, env, ctx)` handler (NOT
// `fetch`), so to support the audit-rotation cron (admin-setup-wizard task
// 11.4; Req 15.5; design §10.2 — cron `0 * * * *`) the default export is now an
// `ExportedHandler` object exposing BOTH:
//   • `fetch`     — delegates to the Hono app unchanged (the HTTP request path
//                   is byte-for-byte identical to before).
//   • `scheduled` — the WORKERS half of the runtime-split rotation. Self-hosted
//                   Node uses `node-cron` in serve.ts; Workers uses this Cron
//                   Trigger handler. node-cron is intentionally NOT imported
//                   here so it never leaks into the Workers bundle.
// ── Sentry wrapper ──────────────────────────────────────────────────────────
//
// `withSentry` wraps the ExportedHandler so unhandled errors in BOTH `fetch`
// and `scheduled` are captured, with tracing + structured logs. Options are
// resolved per-request from `env` (the Worker has no `process.env`); when
// `SENTRY_DSN` is unset the DSN is empty and Sentry is a no-op — so dev/test
// stay clean. The Node/Docker entry (`serve.ts`) is intentionally untouched:
// `@sentry/cloudflare` only runs on the Workers isolate.
//
// `nodejs_compat` is already set in wrangler.toml, satisfying the SDK's
// AsyncLocalStorage requirement.
export default Sentry.withSentry(
  (env: Bindings) => resolveSentryOptions(env),
  {
  // Bind so `this` inside Hono's fetch stays the app instance.
  fetch: app.fetch.bind(app),

  /**
   * Cloudflare Cron Trigger handler (design §10.2). Fires on the
   * `[triggers] crons` schedule in wrangler.toml (`0 * * * *`, hourly).
   *
   * Builds a Drizzle client from the Hyperdrive binding — the SAME fallback
   * path `middleware/db.ts` uses (`createDb(hyperdrive.connectionString)`) —
   * and runs the shared `runScheduledRotation`, wrapped in `ctx.waitUntil`
   * so the isolate stays alive until the prune completes.
   *
   * Never throws: `runScheduledRotation` is best-effort, and the missing-
   * binding branch logs + returns rather than raising, so a misconfigured
   * cron can't surface as a Worker error.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Bindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    const hyperdrive = env.HYPERDRIVE;
    if (!hyperdrive) {
      console.error(
        '[lumibase-cms] scheduled audit rotation skipped: HYPERDRIVE binding ' +
          'is not configured.',
      );
      return;
    }

    const db = createDb(hyperdrive.connectionString);
    // waitUntil keeps the isolate alive until the (best-effort) prune finishes.
    ctx.waitUntil(runScheduledRotation(db));
  },
  } satisfies ExportedHandler<Bindings>,
);

// Durable Object class — only bundled by Wrangler's CF bundler.
// Wrangler reads `class_name = "SiteRoom"` in wrangler.toml and expects
// this export to exist in the compiled worker bundle.
export { SiteRoom } from './realtime/site-room';
