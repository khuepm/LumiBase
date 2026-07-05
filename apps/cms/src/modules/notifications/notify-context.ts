/**
 * Request-context bridge for the agent notification broadcaster (push-noti
 * feature). Route handlers call {@link buildAgentNotifier} to obtain an
 * {@link AgentNotifier} bound to the current site, the SiteRoom DO namespace
 * (Cloudflare), and the VAPID env — then hand it to the services they build.
 *
 * The returned notifier is fire-and-forget: it kicks off the fan-out and
 * returns immediately so emitting a notification never adds latency to (or can
 * fail) the request that produced the event.
 */

import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { emitAgentNotification, type AgentNotifier } from './agent-notifications';

/** Merge Worker bindings (`c.env`) over `process.env` so VAPID keys resolve in both runtimes. */
function mergedEnv(c: Context<AppEnv>): Record<string, string | undefined> {
  const fromProcess = typeof process !== 'undefined' ? process.env : {};
  return { ...fromProcess, ...(c.env as unknown as Record<string, string | undefined>) };
}

export function buildAgentNotifier(c: Context<AppEnv>): AgentNotifier {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const doNamespace = (c.env as unknown as Record<string, DurableObjectNamespace | undefined>)['SITE_ROOM'];
  const env = mergedEnv(c);

  return (input) => {
    void emitAgentNotification({ db, siteId, doNamespace, env }, input);
  };
}
