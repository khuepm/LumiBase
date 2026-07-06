import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { canReadObservabilityDetail } from './metrics';

type ServiceStatus = 'healthy' | 'unhealthy';
type OverallStatus = 'healthy' | 'degraded';
type ServiceName = keyof HealthResponse['services'];

interface HealthResponse {
  status: OverallStatus;
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
 * This endpoint does NOT require authentication so load balancers and uptime
 * probes can reach it. To avoid leaking infrastructure topology to anonymous
 * callers (CWE-668), the per-subsystem breakdown is only returned to callers
 * presenting a valid observability token; everyone else sees the overall
 * status only.
 */
export const healthRouter = new Hono<AppEnv>();

const HEALTH_PROBE_TIMEOUT_MS = 750;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('health probe timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function probeService(
  check: () => Promise<boolean>,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<ServiceStatus> {
  try {
    return (await withTimeout(check(), timeoutMs)) ? 'healthy' : 'unhealthy';
  } catch {
    return 'unhealthy';
  }
}

async function collectHealth(c: Context<AppEnv>): Promise<HealthResponse> {
  const runtime = c.get('runtime');

  const probes: Record<ServiceName, Promise<ServiceStatus>> = {
    database: probeService(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sql = runtime.database.getConnection() as any;
      await sql`SELECT 1`;
      return true;
      // A cold Hyperdrive connection to a distant Postgres can exceed the
      // default 750ms probe budget, so give the DB probe extra headroom.
    }, 3000),

    cache: probeService(async () => {
      const healthKey = '__lumibase_health_check__';
      // Cloudflare KV enforces a 60s minimum expirationTtl; anything lower
      // (the old 10s) makes kv.put throw and the probe report unhealthy even
      // though KV is reachable.
      await runtime.cache.set(healthKey, JSON.stringify('ok'), { ttl: 60 });
      const val = await runtime.cache.get(healthKey);
      return val !== null;
    }),

    search: probeService(async () => {
      try {
        await runtime.search.getIndex('_health');
        return true;
      } catch (err: unknown) {
        // MeiliSearch returns an error for non-existent indexes, but if we get
        // a response at all it means the service is reachable. Distinguish
        // between "index not found" (service is up) and "connection refused".
        const message = err instanceof Error ? err.message : String(err);
        return message.includes('index_not_found') || message.includes('not found');
      }
    }),

    storage: probeService(async () => {
      await runtime.storage.list('__health__');
      return true;
    }),

    queue: probeService(async () => {
      const jobId = await runtime.queue.enqueue(
        '_health',
        'health_check',
        { ts: Date.now() },
        { attempts: 1 },
      );
      return Boolean(jobId);
      // First enqueue after a cold start can exceed the default 750ms budget.
    }, 3000),
  };

  const entries = await Promise.all(
    Object.entries(probes).map(async ([service, probe]) => [service, await probe] as const),
  );
  const results = Object.fromEntries(entries) as HealthResponse['services'];

  // Determine overall status.
  const allHealthy = Object.values(results).every((s) => s === 'healthy');
  const response: HealthResponse = {
    status: allHealthy ? 'healthy' : 'degraded',
    services: results,
  };

  return response;
}

/** Strip the per-subsystem detail unless the caller is trusted. */
function shapeHealth(c: Context<AppEnv>, full: HealthResponse): HealthResponse | { status: OverallStatus } {
  if (canReadObservabilityDetail(c.env, c.req.header('authorization'))) {
    return full;
  }
  return { status: full.status };
}

healthRouter.get('/', async (c) => c.json(shapeHealth(c, await collectHealth(c)), 200));

healthRouter.get('/ready', async (c) => {
  const response = await collectHealth(c);
  return c.json(shapeHealth(c, response), response.status === 'healthy' ? 200 : 503);
});
