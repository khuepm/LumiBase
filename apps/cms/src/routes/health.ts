import { Hono } from 'hono';
import type { AppEnv } from '../env';

type ServiceStatus = 'healthy' | 'unhealthy';

interface HealthResponse {
  status: 'healthy' | 'degraded';
  services: {
    database: ServiceStatus;
    cache: ServiceStatus;
    search: ServiceStatus;
    storage: ServiceStatus;
    queue: ServiceStatus;
  };
}

/**
 * Health check route.
 *
 * Checks connectivity to all backing services (database, cache/Redis,
 * search/MeiliSearch, storage/S3, queue). Returns 200 with `status: 'healthy'`
 * when all services are reachable, or 200 with `status: 'degraded'` when one
 * or more non-critical services are down.
 *
 * This endpoint does NOT require authentication.
 */
export const healthRouter = new Hono<AppEnv>();

healthRouter.get('/', async (c) => {
  const runtime = c.get('runtime');

  const results: HealthResponse['services'] = {
    database: 'unhealthy',
    cache: 'unhealthy',
    search: 'unhealthy',
    storage: 'unhealthy',
    queue: 'unhealthy',
  };

  // Check database connectivity via a simple query.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sql = runtime.database.getConnection() as any;
    await sql`SELECT 1`;
    results.database = 'healthy';
  } catch {
    // Database unreachable.
  }

  // Check cache (Redis / KV) connectivity via set + get.
  try {
    const healthKey = '__lumibase_health_check__';
    await runtime.cache.set(healthKey, JSON.stringify('ok'), { ttl: 10 });
    const val = await runtime.cache.get(healthKey);
    if (val !== null) {
      results.cache = 'healthy';
    }
  } catch {
    // Cache unreachable.
  }

  // Check search (MeiliSearch) connectivity via getIndex.
  try {
    await runtime.search.getIndex('_health');
    results.search = 'healthy';
  } catch (err: unknown) {
    // MeiliSearch returns an error for non-existent indexes, but if we get
    // a response at all it means the service is reachable. Distinguish
    // between "index not found" (service is up) and "connection refused".
    const message = err instanceof Error ? err.message : String(err);
    // MeiliSearch client throws with specific error codes for missing indexes.
    // If the error indicates the index doesn't exist, the service is still healthy.
    if (
      message.includes('index_not_found') ||
      message.includes('not found')
    ) {
      results.search = 'healthy';
    }
  }

  // Check storage (S3/MinIO / R2) connectivity via list.
  try {
    await runtime.storage.list('__health__');
    results.storage = 'healthy';
  } catch {
    // Storage unreachable.
  }

  // Check queue connectivity via enqueue + getStatus.
  try {
    const jobId = await runtime.queue.enqueue(
      '_health',
      'health_check',
      { ts: Date.now() },
      { attempts: 1 },
    );
    if (jobId) {
      results.queue = 'healthy';
    }
  } catch {
    // Queue unreachable.
  }

  // Determine overall status.
  const allHealthy = Object.values(results).every((s) => s === 'healthy');
  const response: HealthResponse = {
    status: allHealthy ? 'healthy' : 'degraded',
    services: results,
  };

  return c.json(response, 200);
});
