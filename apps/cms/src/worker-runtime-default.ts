import type { Bindings } from './env';

/**
 * A Worker is always the Cloudflare runtime, whatever the environment config says.
 *
 * `withRuntime`, the email/notification channels and the realtime route all read
 * `LUMIBASE_RUNTIME` and default to `docker` when it is unset. That default is
 * right for `serve.ts` and impossible here: the Docker adapters are aliased out
 * of the Worker bundle, so a wrangler env without the var (staging/dev/demo)
 * returned 500 on every request, `/health` included. Filling the default at the
 * entry keeps each env block from having to remember it; an explicit value is
 * left alone so a genuine misconfiguration still fails loudly.
 */
export function withWorkerRuntimeDefault(env: Bindings): Bindings {
  if (env.LUMIBASE_RUNTIME) return env;
  return { ...env, LUMIBASE_RUNTIME: 'cloudflare' };
}
