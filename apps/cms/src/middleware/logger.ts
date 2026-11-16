import type { MiddlewareHandler } from 'hono';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../env';
import { captureOpsError } from '../modules/ops/capture';

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
    // 5xx answered without a throw (503 RLS_MISCONFIGURED, 502 upstream…) —
    // onError already captured thrown ones; captureOpsError dedupes per request.
    if (c.res.status >= 500 && !c.get('opsErrorCaptured')) {
      captureOpsError(c, { status: c.res.status, errorCode: errorCodeOf(c.res) });
    }
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

/** `errors[0].code` of a JSON error body, read from a clone (the original still streams). */
async function errorCodeOf(res: Response): Promise<string | null> {
  try {
    if (!res.headers.get('content-type')?.includes('application/json')) return null;
    const body = (await res.clone().json()) as { errors?: Array<{ code?: unknown }> };
    const code = body?.errors?.[0]?.code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}
