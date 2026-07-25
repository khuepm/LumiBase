/**
 * Realtime WebSocket upgrade endpoint + ticket issuance.
 *
 * The WS handshake cannot carry Authorization headers in browsers, so clients
 * first exchange their session auth for a short-lived (1 min) ticket, then open
 * `GET /api/v1/realtime?ticket=<jwt>`. The route verifies the ticket, derives
 * the session principal (plane / userId / subjectId / channel allowlist) from
 * the SIGNED ticket — never from the query string — and forwards the upgrade to
 * the SiteRoom Durable Object.
 *
 * Two ticket kinds, two planes:
 *   - POST /realtime/ticket          → studio ticket  (admin, `users` table)
 *   - POST /realtime/audience-ticket → audience ticket (end-user, app-owned
 *                                      table, keyed by e.g. citizenID → subjectId)
 *
 * Multi-region: on Cloudflare the studio room is routed to the nearest colo via
 * `locationHint`. The audience room uses a dedicated `{siteId}:aud` name.
 */

import { Hono, type Context } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
import { formatSafeError } from '@lumibase/shared/utils';
import type { AppEnv } from '../env';
import { getLocationHint, resolveRoomName } from '../realtime/shard-config';
import { resolveAudienceGrant } from '../realtime/audience-grant';
import { readableCollections } from '../realtime/studio-grant';
import { permissionServiceForRequest } from '../services/item-service-factory';

export const realtimeRouter = new Hono<AppEnv>();

function getJwtSecret(c: Context<AppEnv>): Uint8Array | null {
  const secret = c.env.JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) return null;
  return new TextEncoder().encode(secret);
}

// ─── Studio ticket (admin) ──────────────────────────────────────────────────

realtimeRouter.post('/ticket', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.json({ errors: [{ code: 'UNAUTHENTICATED', message: 'Not authenticated' }] }, 401);
  }

  const secretKey = getJwtSecret(c);
  if (!secretKey) {
    return c.json({ errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET missing' }] }, 500);
  }

  // Subscription read-gate: resolve the collections this principal can `read`
  // and embed them in the SIGNED ticket. The hub enforces the allowlist on
  // every `subscribe` (it has no DB context of its own). Fail-closed: if the
  // bundle cannot be resolved, the ticket carries an empty allowlist and every
  // subscribe is denied — never a wide-open ticket on error.
  let collections: string[] = [];
  try {
    collections = readableCollections(await permissionServiceForRequest(c).bundle());
  } catch (err) {
    console.warn('[realtime] readable-collections resolution failed; issuing fail-closed ticket', formatSafeError(err));
  }

  const ticket = await new SignJWT({
    plane: 'studio',
    userId: auth.userId || auth.externalId || 'anon',
    roles: auth.roles || [],
    collections,
    siteId: c.get('siteId'),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(secretKey);

  return c.json({ data: { ticket } }, 200);
});

// ─── Audience ticket (end-user / frontend) ──────────────────────────────────

realtimeRouter.post('/audience-ticket', async (c) => {
  const auth = c.get('auth');
  if (!auth) {
    return c.json({ errors: [{ code: 'UNAUTHENTICATED', message: 'Not authenticated' }] }, 401);
  }

  const secretKey = getJwtSecret(c);
  if (!secretKey) {
    return c.json({ errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET missing' }] }, 500);
  }

  // Optional list of channels the client asks to be allowed to join.
  let requestedChannels: string[] = [];
  try {
    const body = (await c.req.json()) as { channels?: unknown };
    if (Array.isArray(body?.channels)) {
      requestedChannels = body.channels.filter((c): c is string => typeof c === 'string');
    }
  } catch {
    /* no body — subject-only ticket */
  }

  // Authz decision lives HERE (route has DB/runtime context), not in the DO.
  // resolveAudienceGrant maps the authenticated FE principal to a subjectId and
  // an approved channel allowlist. Requested channels are intersected with what
  // the principal is actually allowed to join.
  const grant = resolveAudienceGrant(auth, requestedChannels);
  if (!grant) {
    return c.json(
      { errors: [{ code: 'FORBIDDEN', message: 'Not eligible for an audience ticket' }] },
      403,
    );
  }

  const ticket = await new SignJWT({
    plane: 'public',
    subjectId: grant.subjectId,
    channels: grant.channels,
    siteId: c.get('siteId'),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(secretKey);

  return c.json({ data: { ticket, subjectId: grant.subjectId, channels: grant.channels } }, 200);
});

// ─── WebSocket upgrade ──────────────────────────────────────────────────────

realtimeRouter.get('/', async (c) => {
  const upgradeHeader = c.req.header('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return c.json(
      {
        status: 'realtime_ready',
        message: 'Connect with ws://.../api/v1/realtime?ticket=<ticket>',
        supportedProtocols: ['lumibase-sync-v1'],
      },
      200,
    );
  }

  const ticket = c.req.query('ticket');
  if (!ticket) {
    return c.json({ errors: [{ code: 'UNAUTHENTICATED', message: 'Missing realtime ticket' }] }, 401);
  }

  const secretKey = getJwtSecret(c);
  if (!secretKey) {
    return c.json({ errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET missing' }] }, 500);
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(ticket, secretKey, { algorithms: ['HS256'] });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return c.json({ errors: [{ code: 'UNAUTHENTICATED', message: 'Invalid or expired ticket' }] }, 401);
  }

  const siteId = String(payload.siteId ?? '');
  // Defence in depth: a requested siteId in the query must match the ticket.
  const requestedSiteId = c.req.query('siteId') || c.req.query('site');
  if (requestedSiteId && requestedSiteId !== siteId) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Ticket does not match requested site' }] }, 403);
  }

  const plane = payload.plane === 'public' ? 'public' : 'studio';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const siteRoom = (c.env as unknown as Record<string, DurableObjectNamespace>)['SITE_ROOM'];
  if (!siteRoom) {
    // Docker / Node: DO not available here. The Node WS server (serve.ts)
    // handles this route directly; reaching here means realtime isn't wired.
    return c.json(
      {
        error: 'REALTIME_NOT_AVAILABLE',
        message:
          'Realtime Durable Object is not bound in this environment. ' +
          'On Cloudflare, set up the SITE_ROOM binding in wrangler.toml; ' +
          'on Docker, the Node WebSocket server handles /realtime directly.',
      },
      501,
    );
  }

  // Determine the room name (single source of truth shared with publish).
  const runtimeMode = (c.env as unknown as Record<string, string | undefined>)['LUMIBASE_RUNTIME'];
  const cfColo = (c.req.raw as unknown as { cf?: { colo?: string } })?.cf?.colo;
  const region = plane === 'studio' ? getLocationHint(runtimeMode, cfColo) : undefined;
  const doName = resolveRoomName(siteId, { plane, region });

  const id = siteRoom.idFromName(doName);
  const stub = region
    ? siteRoom.get(id, { locationHint: region as unknown as DurableObjectLocationHint })
    : siteRoom.get(id);

  // Forward the verified principal to the DO via internal query params. The DO
  // trusts these because they originate from a signed ticket, not the client.
  const url = new URL(c.req.url);
  url.searchParams.set('plane', plane);
  url.searchParams.set('siteId', siteId);
  if (plane === 'studio') {
    url.searchParams.set('userId', String(payload.userId ?? 'anon'));
    const collections = Array.isArray(payload.collections) ? (payload.collections as string[]) : [];
    url.searchParams.set('collections', collections.join(','));
  } else {
    url.searchParams.set('subjectId', String(payload.subjectId ?? ''));
    const channels = Array.isArray(payload.channels) ? (payload.channels as string[]) : [];
    url.searchParams.set('channels', channels.join(','));
  }

  return stub.fetch(new Request(url.toString(), c.req.raw));
});
