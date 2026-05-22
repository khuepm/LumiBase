import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import type { AppEnv } from '../env';

// ---------------------------------------------------------------------------
// Registry & default metrics
// ---------------------------------------------------------------------------

export const register = new Registry();
try {
  if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function') {
    collectDefaultMetrics({ register });
  } else {
    console.warn('[metrics] process.cpuUsage is not available. Skipping default metrics collection.');
  }
} catch (err) {
  console.warn('[metrics] Failed to collect default metrics:', err);
}

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

/** Total HTTP requests processed. */
export const httpRequestsTotal = new Counter({
  name: 'lumibase_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [register],
});

/** HTTP request duration in seconds. */
export const httpRequestDuration = new Histogram({
  name: 'lumibase_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/** Cache operations counter (hit/miss). */
export const cacheOperationsTotal = new Counter({
  name: 'lumibase_cache_operations_total',
  help: 'Total cache operations',
  labelNames: ['operation', 'hit'] as const,
  registers: [register],
});

/** Queue jobs counter by queue name and status. */
export const queueJobsTotal = new Counter({
  name: 'lumibase_queue_jobs_total',
  help: 'Total queue jobs processed',
  labelNames: ['queue', 'status'] as const,
  registers: [register],
});

/** Search queries counter by collection. */
export const searchQueriesTotal = new Counter({
  name: 'lumibase_search_queries_total',
  help: 'Total search queries',
  labelNames: ['collection'] as const,
  registers: [register],
});

/** Search query duration in seconds. */
export const searchDuration = new Histogram({
  name: 'lumibase_search_duration_seconds',
  help: 'Search query duration in seconds',
  labelNames: ['collection'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// ---------------------------------------------------------------------------
// SLO / business metrics — Phase G8
// ---------------------------------------------------------------------------

/** Item mutations (create/update/delete) — used for SLO + business KPIs. */
export const itemMutationsTotal = new Counter({
  name: 'lumibase_item_mutations_total',
  help: 'Total item mutations performed',
  labelNames: ['collection', 'action', 'status'] as const,
  registers: [register],
});

/** Permission denials counter — security signal. */
export const permissionDenialsTotal = new Counter({
  name: 'lumibase_permission_denials_total',
  help: 'Total permission denials',
  labelNames: ['collection', 'action'] as const,
  registers: [register],
});

/** Realtime / WebSocket connection gauge (current open connections). */
export const realtimeConnectionsTotal = new Counter({
  name: 'lumibase_realtime_connections_total',
  help: 'Cumulative realtime connections opened',
  labelNames: ['site'] as const,
  registers: [register],
});

/** Webhook dispatch outcome counter (success / failure). */
export const webhookDispatchTotal = new Counter({
  name: 'lumibase_webhook_dispatch_total',
  help: 'Total webhook dispatches',
  labelNames: ['target', 'status'] as const,
  registers: [register],
});

/** Database query duration histogram (per operation type). */
export const dbQueryDuration = new Histogram({
  name: 'lumibase_db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Metrics middleware — records request count + duration for every request
// ---------------------------------------------------------------------------

/**
 * Middleware that records HTTP request metrics (count and duration).
 *
 * Attach this early in the middleware chain so it captures all requests.
 * The `/metrics` path itself is excluded to avoid self-referential noise.
 */
export const withMetrics = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    // Skip recording metrics for the /metrics endpoint itself.
    if (c.req.path === '/metrics') {
      await next();
      return;
    }

    const start = performance.now();
    await next();
    const durationSec = (performance.now() - start) / 1000;

    // Normalize path to avoid high-cardinality labels.
    // Replace UUIDs and numeric IDs with placeholders.
    const normalizedPath = c.req.path
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        ':id',
      )
      .replace(/\/\d+/g, '/:id');

    const method = c.req.method;
    const status = String(c.res.status);

    httpRequestsTotal.inc({ method, path: normalizedPath, status });
    httpRequestDuration.observe({ method, path: normalizedPath }, durationSec);
  });

// ---------------------------------------------------------------------------
// Metrics route — GET /metrics
// ---------------------------------------------------------------------------

export const metricsRouter = new Hono<AppEnv>();

metricsRouter.get('/', async (c) => {
  const metrics = await register.metrics();
  return c.text(metrics, 200, {
    'Content-Type': register.contentType,
  });
});
