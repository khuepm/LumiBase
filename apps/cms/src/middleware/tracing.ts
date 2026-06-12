import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { normalizeObservabilityPath } from '../routes/metrics';

type Span = {
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attributes: Record<string, string | number | boolean | undefined>): void;
  recordException(error: Error): void;
  end(): void;
};

type TraceApi = {
  trace: {
    getTracer(name: string): {
      startSpan(name: string, options?: Record<string, unknown>): Span;
    };
  };
  SpanStatusCode?: { ERROR: number };
};

let traceApiPromise: Promise<TraceApi | null> | null = null;

async function getTraceApi(): Promise<TraceApi | null> {
  // @opentelemetry/api is an optional peer — import() resolves at runtime, .catch() handles missing package
  traceApiPromise ??= (import('@opentelemetry/api' as string) as Promise<unknown>).then(m => m as TraceApi).catch(() => null);
  return traceApiPromise;
}

function tracingEnabled(env: AppEnv['Bindings']): boolean {
  const raw = (env as unknown as Record<string, string | undefined>).LUMIBASE_TRACING_ENABLED ?? process.env.LUMIBASE_TRACING_ENABLED;
  return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}

export const withTracing = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!tracingEnabled(c.env)) {
      await next();
      return;
    }

    const api = await getTraceApi();
    if (!api) {
      await next();
      return;
    }

    const normalizedPath = normalizeObservabilityPath(c.req.path);
    const span = api.trace.getTracer('lumibase-cms').startSpan(`${c.req.method} ${normalizedPath}`, {
      attributes: {
        'http.request.method': c.req.method,
        'url.path': normalizedPath,
        'lumibase.request_id': c.get('requestId') ?? '',
      },
    });

    const start = performance.now();
    try {
      await next();
      span.setAttributes({
        'http.response.status_code': c.res.status,
        'lumibase.duration_ms': Math.round(performance.now() - start),
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      span.recordException(error);
      span.setAttributes({
        'http.response.status_code': 500,
        'lumibase.duration_ms': Math.round(performance.now() - start),
      });
      throw err;
    } finally {
      span.end();
    }
  });
