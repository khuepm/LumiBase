import type { MiddlewareHandler } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../env';

/**
 * Structured request logger. Assigns a `requestId` and prints JSON lines so
 * Workers Logpush can ingest them directly.
 */
export const withLogger = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const requestId = c.req.header('x-request-id') ?? nanoid(12);
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);

  const start = Date.now();
  try {
    await next();
  } finally {
    const durMs = Date.now() - start;
    // Structured log line. Avoid logging full bodies — privacy first.
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durMs,
        site: c.get('siteId'),
        user: c.get('auth')?.userId ?? c.get('auth')?.externalId,
      }),
    );
  }
};
