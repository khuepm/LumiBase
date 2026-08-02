import { createMiddleware } from 'hono/factory';
import { createRuntime } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import type { RuntimeContext } from '@lumibase/runtime';
import { recordCacheOperationEvent } from '../services/cache-observability';

/**
 * Cached singleton runtime for Docker mode.
 *
 * In Docker/Node.js mode the runtime holds long-lived connections (Redis,
 * pg-pool, etc.) so we create it once and reuse across requests.
 *
 * In Cloudflare mode, bindings are per-request (provided via `c.env`), so
 * the runtime must be created fresh each time.
 */
let dockerRuntime: RuntimeContext | null = null;

function wireCacheObservability(runtime: RuntimeContext): void {
  const previous = runtime.cache.onEvent;
  runtime.cache.onEvent = (event) => {
    recordCacheOperationEvent(event);
    previous?.(event);
  };
}

function prepareRuntime(runtime: RuntimeContext): RuntimeContext {
  wireCacheObservability(runtime);
  return runtime;
}

/**
 * Middleware that creates a RuntimeContext and injects it into the Hono
 * context as `c.get('runtime')`.
 */
export const withRuntime = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    const mode = (c.env.LUMIBASE_RUNTIME as string | undefined) || (process.env.LUMIBASE_RUNTIME as string | undefined) || 'docker';

    if (mode === 'docker') {
      // Singleton: reuse the runtime across requests since it holds connections.
      if (!dockerRuntime) {
        const envVars = { ...process.env, ...c.env };
        dockerRuntime = prepareRuntime(createRuntime(envVars as unknown as Record<string, unknown>));
      }
      c.set('runtime', dockerRuntime);
    } else {
      // Cloudflare: create per-request because bindings are request-scoped.
      const envVars = { ...process.env, ...c.env };
      const runtime = prepareRuntime(createRuntime(envVars as unknown as Record<string, unknown>));
      c.set('runtime', runtime);
    }

    await next();
  });
