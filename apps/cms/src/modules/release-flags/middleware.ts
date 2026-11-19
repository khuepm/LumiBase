import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../../env';
import { runDetached } from '../../lib/detached';
import { systemDbFor } from '../../middleware/db';
import { pickReleaseEnv, rememberReleaseEnv } from './gate';
import type { ReleaseFlagKey } from './registry';
import type { ReleaseFlagState } from './resolver';
import { evaluateReleaseFlags, maybeStartReleasePull, type ReleaseEnv } from './service';

declare module '../../env' {
  interface Variables {
    /** Release-flag states for the active site, evaluated once per request (#869). */
    releaseFlags?: ReadonlyMap<string, ReleaseFlagState>;
  }
}

type AppContext = Context<AppEnv>;

/**
 * Worker bindings first, then `process.env` for the Node/Docker entry. The
 * result is remembered for evaluations outside a request (`./gate`).
 */
export function releaseEnvFrom(c: AppContext): ReleaseEnv {
  const env = pickReleaseEnv(c.env);
  rememberReleaseEnv(env);
  return env;
}

/**
 * Every flag's state for the active site. Evaluated at most once per request
 * and kept on the context, so several gates in one request cost one
 * evaluation. Also starts a background manifest pull when the opt-in pull
 * channel is configured and due.
 */
export async function releaseFlagStates(c: AppContext): Promise<ReadonlyMap<string, ReleaseFlagState>> {
  const memo = c.get('releaseFlags');
  if (memo) return memo;
  const env = releaseEnvFrom(c);
  const systemDb = systemDbFor(c);
  const pending = maybeStartReleasePull({ systemDb, env });
  if (pending) runDetached(c, pending);
  const states = await evaluateReleaseFlags({
    systemDb,
    db: c.get('db'),
    cache: c.get('runtime')?.cache,
    siteId: c.get('siteId') ?? null,
    env,
  });
  c.set('releaseFlags', states);
  return states;
}

/** Whether the gated code path may run for this request's site. */
export async function isReleaseFlagEnabled(c: AppContext, key: ReleaseFlagKey): Promise<boolean> {
  return (await releaseFlagStates(c)).get(key)?.enabled === true;
}

/**
 * Gate a route on a release flag. While the flag is off the route answers
 * exactly like an unknown route (`404 NOT_FOUND`), so a dark feature does not
 * reveal that it exists.
 */
export function requireReleaseFlag(key: ReleaseFlagKey): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (await isReleaseFlagEnabled(c, key)) return next();
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] }, 404);
  };
}
