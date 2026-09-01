import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import { createRuntime, getSharedRealtimeHub, leaderLockedCallback } from '@lumibase/runtime';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema } from '@lumibase/database';
import cron, { type ScheduledTask } from 'node-cron';
import { loadSecretFiles, validateProductionConfig } from './config/production';
import { runScheduledRotation } from './modules/audit/scheduled';
import { runScheduledRefreshTokenPrune } from './services/auth/refresh-token';
import { bootstrapNodeObservability } from './observability/node';
import { formatSafeError } from '@lumibase/contracts/utils';
import { createPressureLimiter } from './pressure-limiter';
import { startWorkerHealthServer } from './worker-health';
import type { Bindings } from './env';

type ProcessRole = 'web' | 'worker' | 'all';

function parseProcessRole(): ProcessRole {
  const raw = (process.env.LUMIBASE_PROCESS_ROLE || 'all').toLowerCase();
  if (raw === 'web' || raw === 'worker' || raw === 'all') {
    return raw;
  }
  console.warn(
    `[lumibase-cms] Invalid LUMIBASE_PROCESS_ROLE="${raw}" — expected web|worker|all; defaulting to "all"`,
  );
  return 'all';
}

async function main() {
  loadSecretFiles();
  validateProductionConfig();

  // Bootstrap Node observability before importing the Hono app so optional
  // OpenTelemetry auto-instrumentations can patch supported modules early.
  const observability = await bootstrapNodeObservability(process.env);
  const { default: app } = await import('./index');

  const role = parseProcessRole();
  const runHttp = role === 'web' || role === 'all';
  const runWorkers = role === 'worker' || role === 'all';
  const redisUrl = process.env.REDIS_URL;
  const lockOpts = { redisUrl };

  const port = parseInt(process.env.PORT || '1989', 10);
  const workerHealthPort = parseInt(
    process.env.LUMIBASE_WORKER_HEALTH_PORT || String(port === 1989 ? 1988 : port + 1),
    10,
  );
  const runtime = createRuntime(process.env as unknown as Record<string, unknown>);
  const pressureLimiter = createPressureLimiter(process.env as Record<string, string | undefined>);

  let server: ReturnType<typeof serve> | undefined;
  let workerHealthServer: HttpServer | undefined;

  if (runHttp) {
    // Inject runtime into Hono context for all requests.
    app.use('*', async (c, next) => {
      c.set('runtime', runtime);
      await next();
    });

    server = serve({
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
    console.log(`[lumibase-cms] Started in ${runtime.runtime} mode on port ${port} (role=${role})`);
  } else {
    console.log(`[lumibase-cms] HTTP API disabled (role=${role})`);
    workerHealthServer = startWorkerHealthServer(workerHealthPort);
  }

  // ── Realtime WebSocket server (realtime-audience-channels) ──────────────────
  // On Node/Docker there is no Durable Object, so attach a `ws` server to the
  // HTTP server. It shares the in-process hub with the runtime's realtime
  // provider, so `runtime.realtime.publish()` reaches live WS sessions here.
  const jwtSecret = process.env.JWT_SECRET;
  if (runHttp && jwtSecret) {
    const { attachNodeRealtime } = await import('./realtime/node-hub');
    const maxPerSubject = parseInt(process.env.LUMIBASE_REALTIME_MAX_CONNECTIONS_PER_SUBJECT || '0', 10);
    attachNodeRealtime({
      server: server as unknown as HttpServer,
      hub: getSharedRealtimeHub(),
      jwtSecret,
      maxConnectionsPerSubject: Number.isFinite(maxPerSubject) ? maxPerSubject : 0,
    });
    console.log('[lumibase-cms] Realtime WebSocket server attached at /api/v1/realtime');
  } else if (runHttp) {
    console.warn('[lumibase-cms] JWT_SECRET unset — realtime WebSocket server disabled');
  }

  // Cron tasks stopped on SIGTERM (optional when role=web).
  let rotationTask: ScheduledTask | undefined;
  let pageviewFlushTask: ScheduledTask | undefined;
  let vetoSweepTask: ScheduledTask | undefined;
  let schedulerTask: ScheduledTask | undefined;
  let retentionTask: ScheduledTask | undefined;
  let deploymentPollTask: ScheduledTask | undefined;
  let flowScheduleTask: ScheduledTask | undefined;
  let loadGuardTimer: ReturnType<typeof setInterval> | undefined;

  if (runWorkers) {
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
  //   `index.ts` dynamically after observability bootstrap, and `cloudflare.ts`
  //   never imports `serve.ts`, so node-cron can never leak into the Workers bundle.
  //
  // node-cron v4: `schedule()` still auto-starts; `stop()` remains the graceful
  // shutdown hook (see SIGTERM below). Six-field expressions (seconds) stay
  // valid — used by the deployment poll tick. v4 removed
  // `recoverMissedExecutions`: ticks missed while the process was down are
  // not replayed (audit rotation / pageview flush catch up on the next cron).
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
  rotationTask = cron.schedule(
    '0 * * * *',
    leaderLockedCallback(
      'audit-rotation',
      3_300_000,
      () => {
        void runScheduledRotation(rotatorDb);
        void runScheduledRefreshTokenPrune(rotatorDb);
      },
      lockOpts,
    ),
  );

  // Pageview flush — every 5 minutes, roll up raw events and drain hot counters
  // into the daily rollup. Best-effort; never throws (see the module doc).
  const { runScheduledPageviewFlush } = await import('./modules/pageviews/scheduled');
  pageviewFlushTask = cron.schedule(
    '*/5 * * * *',
    leaderLockedCallback(
      'pageview-flush',
      240_000,
      () => {
        void runScheduledPageviewFlush(rotatorDb, runtime);
      },
      lockOpts,
    ),
  );

  if (runHttp) {
  // ── Load-aware autonomy (content-os task 9; Req 9.4/9.5) ─────────────────
  //
  // Feed event-loop pressure samples into the agent load guard: overload
  // pauses reconciler-origin runs at the tool-call boundary (human work is
  // never auto-paused) and a hold-down of continuous calm auto-resumes them.
  const { getLoadGuard } = await import('./services/load-guard-service');
  const loadGuard = getLoadGuard();
    loadGuardTimer = setInterval(() => {
      const sample = pressureLimiter.getSample();
      loadGuard.signal({ overloaded: sample.overloaded, reason: sample.reason });
    }, 5_000);
    loadGuardTimer.unref();
  }

  // ── Async agent runs (content-os task 3; Req 3.2) ────────────────────────
  //
  // Long-lived Node process consumes the `agent-runs` queue so goals created
  // with `execution: 'async'` run outside the request runtime limit. The
  // worker reuses the same Drizzle client as the audit rotator and executes
  // through the harness codepath (capabilities, risk, budget, audit).
  // Cloudflare Workers wire the same handler via their queue consumer export.
  const { registerAgentRunWorker } = await import('./services/agent-run-worker');
  registerAgentRunWorker({
    db: rotatorDb,
    cache: runtime.cache,
    search: runtime.search,
    queue: runtime.queue,
    // Same KeyProvider the request path uses, so deployment skills work
    // identically whether a run is executed sync or off the queue.
    keys: runtime.keys,
    env: process.env as Record<string, string | undefined>,
  });

  // ── Content indexing (search) ────────────────────────────────────────────
  //
  // Consumes the `content-indexing` queue so create/update/delete keep the
  // search index in sync. Without this consumer the jobs ItemService enqueues
  // never run and search results go stale.
  const { registerContentIndexingWorker } = await import(
    './services/content-indexing-worker'
  );
  registerContentIndexingWorker({
    search: runtime.search,
    queue: runtime.queue,
  });

  // ── ISR revalidation dispatch (high-load-cache-readiness task 9.4) ────────
  const { registerRevalidationWorker } = await import('./services/content-invalidation');
  registerRevalidationWorker({ db: rotatorDb, queue: runtime.queue });

  // ── Async audit-log batch writer (high-load-cache-readiness task 12.1) ───
  const { registerAuditLogWorker } = await import('./modules/audit/worker');
  registerAuditLogWorker({ db: rotatorDb, queue: runtime.queue });

  // ── Change Feed dispatch (cdc-extension-integration Req 4.7) ────────────
  //
  // Consumes the `cdc-dispatch` queue (latency path) and runs the 30s sweep
  // (correctness backstop) that delivers outbox events to webhook/extension
  // subscriptions. Without it, push subscriptions never receive events —
  // pull consumers are unaffected.
  const {
    registerCdcDispatchWorker,
    CdcDispatcher,
    createWebhookEnvelopeSender,
    DrizzleDeliveryLog,
    DrizzleSubscriptionDispatchStore,
  } = await import('./modules/cdc/change-feed/dispatcher');
  const { DrizzleCdcEventStore } = await import('./modules/cdc/change-feed/feed-reader');
  const { ExtensionEnvelopeSender, SandboxCdcSubscriberLoader } = await import(
    './modules/cdc/change-feed/extension-sender'
  );
  const cdcSubscriptionStore = new DrizzleSubscriptionDispatchStore(rotatorDb);
  const { DrizzleRetentionStore, pruneChangeFeed, readRetentionDays } = await import(
    './modules/cdc/change-feed/retention'
  );
  registerCdcDispatchWorker({
    queue: runtime.queue,
    subscriptions: cdcSubscriptionStore,
    prune: async (siteId) => {
      await pruneChangeFeed(
        {
          store: new DrizzleRetentionStore(rotatorDb),
          retentionDays: await readRetentionDays(rotatorDb, siteId),
        },
        siteId,
      );
    },
    buildDispatcher: () =>
      new CdcDispatcher({
        eventStore: new DrizzleCdcEventStore(rotatorDb),
        subscriptions: cdcSubscriptionStore,
        deliveryLog: new DrizzleDeliveryLog(rotatorDb),
        senders: {
          webhook: createWebhookEnvelopeSender(rotatorDb),
          extension: new ExtensionEnvelopeSender({
            loader: new SandboxCdcSubscriberLoader(
              rotatorDb,
              process.env as Record<string, unknown>,
            ),
          }),
        },
        cache: runtime.cache,
      }),
  });

  // ── Flow event trigger (visual-flow-builder Req 1) ───────────────────────
  //
  // Consumes the `flow-events` queue: ItemService enqueues one job per
  // matching active event-flow on create/update/delete; this worker executes
  // the flow and records the run. Without it, event flows never fire.
  const { registerFlowEventWorker } = await import('./services/flow-dispatch');
  registerFlowEventWorker({
    db: rotatorDb,
    queue: runtime.queue,
    keys: runtime.keys,
  });

  // ── Manual flow runs + AI chat async (high-load task 17) ────────────────
  const { registerFlowRunsWorker } = await import('./services/flow-run-service');
  registerFlowRunsWorker({
    db: rotatorDb,
    queue: runtime.queue,
    keys: runtime.keys,
    env: process.env as Record<string, string | undefined>,
  });

  // ── Veto-window commits (content-os task 14; Req 13.3/13.5) ─────────────
  //
  // Primary path: delayed queue jobs fire at each staging's autoCommitAt.
  // Safety net: a 5-minute sweep commits anything the queue missed (lost
  // jobs, queue-less runtimes). Both converge on VetoService.commit, which
  // re-checks status and deadline — no premature or double commits.
  const { registerVetoCommitWorker, sweepDueVetoCommits } = await import(
    './services/veto-commit-worker'
  );
  const vetoWorkerDeps = {
    db: rotatorDb,
    cache: runtime.cache,
    search: runtime.search,
    queue: runtime.queue,
  };
  registerVetoCommitWorker(vetoWorkerDeps);
  vetoSweepTask = cron.schedule(
    '*/5 * * * *',
    leaderLockedCallback(
      'veto-sweep',
      240_000,
      () => {
        void sweepDueVetoCommits(vetoWorkerDeps).catch((err) => {
          console.error('[veto-sweep] failed', formatSafeError(err));
        });
      },
      lockOpts,
    ),
  );

  // ── Content scheduler (regulated-content-readiness task 7; Req 7.3/7.4) ──
  //
  // A 1-minute tick applies due publish/unpublish transitions. Each flip is a
  // guarded conditional update so catch-up runs after downtime never
  // double-fire side-effects (Req 7.6).
  const { registerSchedulerWorker, runSchedulerTick, sweepRetention } = await import(
    './services/scheduler-worker'
  );
  const schedulerDeps = { db: rotatorDb, queue: runtime.queue };
  registerSchedulerWorker(schedulerDeps);
  schedulerTask = cron.schedule(
    '* * * * *',
    leaderLockedCallback(
      'content-scheduler',
      50_000,
      () => {
        void runSchedulerTick(schedulerDeps).catch((err) => {
          console.error('[content-scheduler] tick failed', formatSafeError(err));
        });
      },
      lockOpts,
    ),
  );
  // Retention sweep runs hourly (Req 12.2) — heavier than the publish tick.
  retentionTask = cron.schedule(
    '17 * * * *',
    leaderLockedCallback(
      'retention-sweep',
      3_300_000,
      () => {
        void sweepRetention(schedulerDeps).catch((err) => {
          console.error('[retention-sweep] failed', formatSafeError(err));
        });
      },
      lockOpts,
    ),
  );

  // ── Deployment status poller (deployment-integrations task 9; Req 3.4) ──
  //
  // A 30-second sweep syncs every non-terminal deployment from its Provider.
  // Each sync is a guarded conditional update (only flips queued/building),
  // and a single provider error never aborts the sweep, so re-running is a
  // no-op (idempotent).
  const { registerStatusPoller, sweepAllSites } = await import('./services/deployment/status-poller');
  const deployPollerDeps = { db: rotatorDb, keys: runtime.keys, queue: runtime.queue };
  registerStatusPoller(deployPollerDeps);
  deploymentPollTask = cron.schedule(
    '*/30 * * * * *',
    leaderLockedCallback(
      'deployment-poll',
      25_000,
      () => {
        void sweepAllSites(deployPollerDeps).catch((err) => {
          console.error('[deployment-poll] sweep failed', formatSafeError(err));
        });
      },
      lockOpts,
    ),
  );

  // ── Flow schedule tick (visual-flow-builder task 4.x) ───────────────────
  //
  // The event-triggered flow consumer is `registerFlowEventWorker` (above).
  // Schedule flows need a periodic sweep: a 1-minute tick enqueues every flow
  // whose `next_run_at` is due onto the same `flow-events` queue (nextRunAt is
  // advanced before enqueue so a slow job never re-fires the same flow).
  const { runDueScheduledFlows } = await import('./services/flow-scheduler');
  flowScheduleTask = cron.schedule(
    '* * * * *',
    leaderLockedCallback(
      'flow-schedule',
      50_000,
      () => {
        void runDueScheduledFlows({ db: rotatorDb, queue: runtime.queue }).catch((err) => {
          console.error('[flow-schedule] tick failed', formatSafeError(err));
        });
      },
      lockOpts,
    ),
  );

  // ── Envelope migration consumer (regulated-content-readiness task 3.6) ──
  //
  // Drains background migrations enqueued when an operator toggles
  // `encryption.envelope`. Batched, resumable, idempotent — safe to re-run.
  const { registerEnvelopeMigrationWorker } = await import('./services/envelope-migration-worker');
  registerEnvelopeMigrationWorker({ db: rotatorDb, keyProvider: runtime.keys, queue: runtime.queue });
  } // runWorkers

  const closeServers = (onClosed: () => void) => {
    const pending: Promise<void>[] = [];
    if (server) {
      pending.push(
        new Promise((resolve) => {
          server!.close(() => resolve());
        }),
      );
    }
    if (workerHealthServer) {
      pending.push(
        new Promise((resolve) => {
          workerHealthServer!.close(() => resolve());
        }),
      );
    }
    if (pending.length === 0) {
      onClosed();
      return;
    }
    void Promise.all(pending).then(onClosed);
  };

  // Graceful shutdown with 10s timeout
  process.on('SIGTERM', () => {
    console.log('[lumibase-cms] SIGTERM received, shutting down...');

    rotationTask?.stop();
    pageviewFlushTask?.stop();
    vetoSweepTask?.stop();
    schedulerTask?.stop();
    retentionTask?.stop();
    deploymentPollTask?.stop();
    flowScheduleTask?.stop();
    if (runHttp) {
      pressureLimiter.stop();
    }
    if (loadGuardTimer) {
      clearInterval(loadGuardTimer);
    }

    // Force exit after 10 seconds if graceful shutdown stalls
    const forceTimeout = setTimeout(() => {
      console.error('[lumibase-cms] Graceful shutdown timed out after 10s, forcing exit.');
      process.exit(1);
    }, 10_000);
    forceTimeout.unref();

    closeServers(async () => {
      try {
        await observability.shutdown();
      } catch (err) {
        console.error('[lumibase-cms] Error shutting down observability:', formatSafeError(err));
      }
      try {
        await runtime.database.close();
      } catch (err) {
        console.error('[lumibase-cms] Error closing database connection:', formatSafeError(err));
      }
      clearTimeout(forceTimeout);
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error('[lumibase-cms] Failed to start:', formatSafeError(err));
  process.exit(1);
});
