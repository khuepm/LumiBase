import { createMiddleware } from 'hono/factory';
// Statically import the Cloudflare factory ONLY. This module is reachable from
// `src/index.ts`, which is the Worker entry's app, so anything imported here
// lands in the Worker bundle. Importing `createRuntime` (which branches between
// adapters) used to drag the whole Docker subtree in — including BullMQ, whose
// Postgres `sql-loader` throws at module top level under Workers and made every
// Cloudflare deploy fail to start. See the note atop `packages/runtime/src/index.ts`.
import { createCloudflareRuntime } from '@lumibase/runtime';
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

/**
 * Optional factory override, set by long-running Node entry points.
 *
 * `serve.ts` already builds a runtime of its own (it needs one outside the
 * request path, for cron and queue consumers). Before this existed it injected
 * that runtime with a second middleware registered *after* `withRuntime`, so
 * Docker mode built **two** runtimes per process — two Redis connections, two
 * pg pools — and threw the first away on every request. Registering the factory
 * here means one runtime per process, and it keeps this module free of any
 * static import of the Docker adapters.
 */
type RuntimeFactory = (env: Record<string, unknown>) => RuntimeContext;
let runtimeFactory: RuntimeFactory | null = null;

/** Overrides how `withRuntime` obtains its RuntimeContext. Node entries only. */
export function setRuntimeFactory(factory: RuntimeFactory | null): void {
  runtimeFactory = factory;
  dockerRuntime = null;
}

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
        // Deliberately a dynamic import on a branch that cannot run under
        // Workers: it keeps the Docker adapters (and their Node-only deps) out
        // of the Worker's startup path. `serve.ts` normally registers its own
        // runtime via `setRuntimeFactory` before serving, so this fallback is
        // for Node contexts that mount `src/index.ts` directly — the
        // golden-path E2E suite being the one that matters.
        const factory =
          runtimeFactory ??
          (await import('@lumibase/runtime/docker')).createDockerRuntime;
        dockerRuntime = prepareRuntime(factory(envVars as unknown as Record<string, unknown>));
      }
      c.set('runtime', dockerRuntime);
    } else {
      // Cloudflare: create per-request because bindings are request-scoped.
      const envVars = { ...process.env, ...c.env };
      const runtime = prepareRuntime(
        (runtimeFactory ?? createCloudflareRuntime)(envVars as unknown as Record<string, unknown>),
      );
      c.set('runtime', runtime);
    }

    await next();
  });
