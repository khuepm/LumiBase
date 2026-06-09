import { serve } from '@hono/node-server';
import { createRuntime } from '@lumibase/runtime';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema } from '@lumibase/database';
import cron from 'node-cron';
import app from './index';
import type { Bindings } from './env';
import { loadSecretFiles, validateProductionConfig } from './config/production';
import { runScheduledRotation } from './modules/audit/scheduled';
import { createPressureLimiter } from './pressure-limiter';

loadSecretFiles();
validateProductionConfig();

const port = parseInt(process.env.PORT || '1989', 10);
const runtime = createRuntime(process.env as unknown as Record<string, unknown>);
const pressureLimiter = createPressureLimiter(process.env as Record<string, string | undefined>);

// Inject runtime into Hono context for all requests.
app.use('*', async (c, next) => {
  c.set('runtime', runtime);
  await next();
});

const server = serve({
  fetch: (request, nodeBindings) => {
    const pressureResponse = pressureLimiter.handle(request);
    if (pressureResponse) return pressureResponse;

    return app.fetch(
      request,
      { ...process.env, ...nodeBindings } as unknown as Bindings,
    );
  },
  port,
});
console.log(`[lumibase-cms] Started in ${runtime.runtime} mode on port ${port}`);

// ── Audit-log retention rotation (admin-setup-wizard task 11.4; Req 15.5;
//    design §10.2) ─────────────────────────────────────────────────────────
//
// The `audit_log` and `login_attempts` tables grow monotonically on the hot
// path; task 11.3's AuditRotator prunes rows past LUMIBASE_AUDIT_RETENTION_DAYS.
// This is the SELF-HOSTED NODE half of "actually fire it on a schedule":
// because this process is long-lived, we drive the prune with `node-cron` on
// the design's `0 * * * *` cadence (top of every hour).
//
// RUNTIME SPLIT — why node-cron lives ONLY here:
//   `node-cron` is a Node-only dependency (Node timers / process internals)
//   that does NOT exist on the Cloudflare Workers isolate. It is therefore
//   imported exclusively from this file — the Node entrypoint bundled by the
//   esbuild `build:node` target. The Workers build bundles `cloudflare.ts`,
//   which schedules the SAME rotation via Cloudflare Cron Triggers + the
//   `scheduled()` handler instead (see cloudflare.ts). `serve.ts` imports
//   `index.ts` (never the reverse), and `cloudflare.ts` never imports
//   `serve.ts`, so node-cron can never leak into the Workers bundle.
//
// The rotator needs a Drizzle client. We mirror `middleware/db.ts`'s runtime
// path: `runtime.database.getConnection()` returns the postgres-js `Sql`
// instance (cast required — the provider types it as `unknown` to avoid
// coupling to postgres-js), which we wrap with the shared `schema`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rotatorDb = drizzle(runtime.database.getConnection() as any, { schema });

// Hourly cron. `runScheduledRotation` is best-effort and never throws, so the
// callback is safe to fire-and-forget; the returned promise only logs the
// pruned-row count. We deliberately rely on the hourly cron alone (no boot-time
// prune) to keep startup side-effect-free — the count-trigger path in the
// audit-context middleware already handles a backlog that accumulates between
// ticks.
const rotationTask = cron.schedule('0 * * * *', () => {
  void runScheduledRotation(rotatorDb);
});

// Graceful shutdown with 10s timeout
process.on('SIGTERM', () => {
  console.log('[lumibase-cms] SIGTERM received, shutting down...');

  // Stop the hourly audit-rotation cron and pressure sampler so their timers
  // can't keep the event loop alive past the server close (task 11.4).
  rotationTask.stop();
  pressureLimiter.stop();

  // Force exit after 10 seconds if graceful shutdown stalls
  const forceTimeout = setTimeout(() => {
    console.error('[lumibase-cms] Graceful shutdown timed out after 10s, forcing exit.');
    process.exit(1);
  }, 10_000);
  forceTimeout.unref();

  server.close(async () => {
    try {
      await runtime.database.close();
    } catch (err) {
      console.error('[lumibase-cms] Error closing database connection:', err);
    }
    clearTimeout(forceTimeout);
    process.exit(0);
  });
});
