import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { PermissionService } from './permission-service';

/**
 * Bump the site's permission-cache version after a successful mutation of
 * roles / policies / permission rows / principal bindings
 * (high-load-cache-readiness Req 2; design §5.1).
 *
 * Call AFTER the write commits and BEFORE the response is returned, so the
 * next request for any principal of the site recompiles its bundle instead
 * of serving a stale one for up to the 60s TTL. Best-effort by design — a
 * cache outage must never fail the mutation (the TTL is the safety net).
 */
export async function bumpPermissionVersion(
  c: Context<AppEnv>,
  siteId: string = c.get('siteId'),
): Promise<void> {
  if (!siteId) return;
  await PermissionService.bumpVersion(c.get('runtime')?.cache, siteId);
}
