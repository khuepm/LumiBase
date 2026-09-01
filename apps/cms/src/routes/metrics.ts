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

function canCollectDefaultMetrics(): boolean {
  try {
    if (typeof process === 'undefined' || typeof process.cpuUsage !== 'function') {
      return false;
    }

    // Wrangler's Workers runtime exposes an unenv stub for cpuUsage() that
    // throws when called. Preflight it so local dev does not spam stack traces.
    process.cpuUsage();
    return true;
  } catch {
    return false;
  }
}

if (canCollectDefaultMetrics()) {
  try {
    collectDefaultMetrics({ register });
  } catch {
    console.warn('[metrics] Failed to collect default metrics. Skipping.');
  }
} else {
  console.warn('[metrics] Default process metrics are not available. Skipping.');
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

/** Cache operations counter (op/result/backend — Req 13). */
export const cacheOperationsTotal = new Counter({
  name: 'lumibase_cache_operations_total',
  help: 'Total cache operations',
  labelNames: ['op', 'result', 'backend'] as const,
  registers: [register],
});

/** Negative-cache (tombstone) hits — distinct from positive data hits (Req 19.15). */
export const cacheNegativeHitsTotal = new Counter({
  name: 'lumibase_cache_negative_hits_total',
  help: 'Cache reads served from a negative (tombstone) entry',
  registers: [register],
});

/** Negative-cache (tombstone) writes after a confirmed DB miss. */
export const cacheNegativeWritesTotal = new Counter({
  name: 'lumibase_cache_negative_writes_total',
  help: 'Tombstone entries written after a confirmed absence',
  registers: [register],
});

/** ISR revalidation dispatch attempts (high-load-cache-readiness Req 8.4). */
export const revalidationDispatchesTotal = new Counter({
  name: 'lumibase_revalidation_dispatches_total',
  help: 'ISR revalidation HTTP dispatches per target result',
  labelNames: ['ok'] as const,
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

/** Audit writes that fell through to the structured stderr fallback (Req 11.4). */
export const auditFallbackTotal = new Counter({
  name: 'lumibase_audit_fallback_total',
  help: 'Audit log writes that used the structured stderr fallback after enqueue and sync insert failed',
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
export function normalizeObservabilityPath(path: string): string {
  return path
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ':id',
    )
    .replace(/\/\d+/g, '/:id');
}

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
    const normalizedPath = normalizeObservabilityPath(c.req.path);

    const method = c.req.method;
    const status = String(c.res.status);

    httpRequestsTotal.inc({ method, path: normalizedPath, status });
    httpRequestDuration.observe({ method, path: normalizedPath }, durationSec);
  });


function processEnvValue(key: string): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env[key] : undefined;
  } catch {
    return undefined;
  }
}

function isProductionMetricsEnv(env: AppEnv['Bindings'] | undefined): boolean {
  return env?.LUMIBASE_ENV === 'production' || processEnvValue('LUMIBASE_ENV') === 'production';
}

function resolveMetricsToken(env: AppEnv['Bindings'] | undefined): string | undefined {
  return env?.METRICS_TOKEN || processEnvValue('METRICS_TOKEN');
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function canReadMetrics(env: AppEnv['Bindings'] | undefined, authorization: string | undefined): boolean {
  const expected = resolveMetricsToken(env);
  // When a token is configured, enforce it in *every* environment. Previously
  // the token was only checked in production, leaving metrics wide open on
  // staging/preview stacks (CWE-284/668).
  if (expected) {
    const actual = extractBearerToken(authorization);
    return actual !== null && constantTimeEqual(actual, expected);
  }
  // No token configured: allow only outside production (dev convenience).
  return !isProductionMetricsEnv(env);
}

/**
 * Whether the caller may see detailed observability output (per-subsystem
 * health, Prometheus metrics). Reuses the metrics-token gate so `/health` and
 * `/metrics` share one trust boundary.
 */
export function canReadObservabilityDetail(
  env: AppEnv['Bindings'] | undefined,
  authorization: string | undefined,
): boolean {
  return canReadMetrics(env, authorization);
}

// ---------------------------------------------------------------------------
// Metrics route — GET /metrics
// ---------------------------------------------------------------------------

export const metricsRouter = new Hono<AppEnv>();

metricsRouter.get('/', async (c) => {
  if (!canReadMetrics(c.env, c.req.header('authorization'))) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] }, 404);
  }

  const metrics = await register.metrics();
  return c.text(metrics, 200, {
    'Content-Type': register.contentType,
  });
});
