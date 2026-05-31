import { createMiddleware } from 'hono/factory';
import { createRuntime } from '@lumibase/runtime';
import type { AppEnv } from '../env';
import type { RuntimeContext } from '@lumibase/runtime';

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
        dockerRuntime = createRuntime(envVars as unknown as Record<string, unknown>);
      }
      c.set('runtime', dockerRuntime);
    } else {
      // Cloudflare: create per-request because bindings are request-scoped.
      const envVars = { ...process.env, ...c.env };
      const runtime = createRuntime(envVars as unknown as Record<string, unknown>);
      c.set('runtime', runtime);
    }

    await next();
  });
