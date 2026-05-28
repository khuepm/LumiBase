/**
 * Realtime WebSocket upgrade endpoint.
 *
 * Forwards the incoming WebSocket upgrade request to the SiteRoom Durable Object
 * for the current site. The DO handles the actual WS handshake and session lifecycle.
 *
 * POST-GA Task #5: Multi-region DO sharding. When running on Cloudflare,
 * we use `locationHint` to route the DO to the nearest region based on the
 * client's colo code. On Docker, this falls back to a single instance.
 *
 * Auth: the client must supply a valid Bearer token in the `?token=<jwt>` query
 * parameter (since the WS handshake cannot carry Authorization headers in browsers).
 *
 * URL: ws(s)://<host>/api/v1/realtime?token=<jwt>&userId=<userId>
 */

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { getLocationHint, getShardKey } from '../realtime/shard-config';

export const realtimeRouter = new Hono<AppEnv>();

realtimeRouter.get('/', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return c.json(
      {
        status: 'realtime_ready',
        message: 'Connect with ws://.../api/v1/realtime?token=<jwt>',
        supportedProtocols: ['lumibase-sync-v1'],
      },
      200,
    );
  }

  // Resolve the SiteRoom Durable Object for this site.
  const siteId = c.get('siteId');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const siteRoom = (c.env as unknown as Record<string, DurableObjectNamespace>)['SITE_ROOM'];

  if (!siteRoom) {
    // Docker / local dev: DO not available. Return a 501 with clear message.
    return c.json(
      {
        error: 'REALTIME_NOT_AVAILABLE',
        message:
          'Realtime is only available in Cloudflare Workers environment. ' +
          'Set up SITE_ROOM Durable Object binding in wrangler.toml.',
      },
      501,
    );
  }

  // Determine region hint from Cloudflare colo (POST-GA Task #5)
  const runtimeMode = (c.env as unknown as Record<string, string | undefined>)['LUMIBASE_RUNTIME'];
  const cfColo = (c.req.raw as unknown as { cf?: { colo?: string } })?.cf?.colo;
  const locationHint = getLocationHint(runtimeMode, cfColo);

  // Each site gets its own isolated DO instance.
  // With multi-region sharding, the shard key includes the region.
  const doName = locationHint
    ? getShardKey(siteId, locationHint)
    : siteId;

  const id = siteRoom.idFromName(doName);

  const stub = locationHint
    ? siteRoom.get(id, { locationHint: locationHint as any })
    : siteRoom.get(id);

  // Pass userId from auth context so the DO can associate the session.
  const auth = c.get('auth');
  const userId = auth?.userId ?? auth?.externalId ?? 'anon';

  // Forward the raw Request to the DO — it handles the WS upgrade internally.
  const url = new URL(c.req.url);
  url.searchParams.set('userId', userId);
  url.searchParams.set('siteId', siteId);
  if (locationHint) {
    url.searchParams.set('region', locationHint);
  }

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// Type helper — Cloudflare Workers DurableObjectGetOptions
interface DOGetOptions {
  locationHint?: string;
}
