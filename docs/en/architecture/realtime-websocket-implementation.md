# Realtime WebSocket Implementation

This document describes how to complete the WebSocket integration in the current codebase. The repository already has the initial foundation:

- Upgrade route: `apps/cms/src/routes/realtime.ts`
- Durable Object hub: `apps/cms/src/realtime/site-room.ts`
- Publish path from item mutations: `apps/cms/src/services/item-service.ts`
- SDK client: `packages/sdk/src/realtime/index.ts`

The remaining implementation goal is to add explicit enablement, collection-level opt-in, complete permission checks and operator-facing docs.

## Configuration decision

Do not choose only env or only DB settings. Use three layers:

1. Env/binding: infrastructure capability and kill switch.
2. Site setting: site-level enablement and runtime limits.
3. Collection meta: explicit collection opt-in.

Check order:

```text
SITE_ROOM binding exists
  -> LUMIBASE_REALTIME_ENABLED !== "false"
  -> settings["realtime.enabled"].value.enabled === true
  -> collections.meta.realtime.enabled === true
  -> user has read permission on collection
```

If any step fails, the server returns a clear error and does not open the subscription.

## Data contract

### Env

Add to `apps/cms/src/env.ts`:

```ts
LUMIBASE_REALTIME_ENABLED?: string;
```

Meaning:

- `false`: disables all realtime for the deployment.
- unset or `true`: allows realtime if the site setting is enabled.

### Site setting

Key: `realtime.enabled`

Value:

```ts
type RealtimeSiteSetting = {
  enabled: boolean;
  maxConnectionsPerUser?: number;
  maxSubscriptionsPerConnection?: number;
  heartbeatSeconds?: number;
  idleTimeoutSeconds?: number;
};
```

Runtime defaults:

```ts
{
  enabled: false,
  maxConnectionsPerUser: 5,
  maxSubscriptionsPerConnection: 50,
  heartbeatSeconds: 30,
  idleTimeoutSeconds: 90
}
```

### Collection meta

No new migration is required because `collections.meta` is already JSONB.

```ts
type CollectionRealtimeMeta = {
  realtime?: {
    enabled?: boolean;
    events?: Array<'create' | 'update' | 'delete'>;
    presence?: boolean;
  };
};
```

Default: disabled.

## Backend implementation

### 1. Add a realtime config service

Create a small helper, for example `apps/cms/src/services/realtime-config.ts`:

- `getRealtimeSiteConfig(db, siteId)`
- `isRealtimeDeployEnabled(env)`
- `isCollectionRealtimeEnabled(collection)`
- `assertCollectionRealtimeEnabled(db, siteId, collectionName, action?)`

This helper reads the `settings` table and `collections.meta`. It should not check user permissions by itself.

### 2. Update `/api/v1/realtime`

In `apps/cms/src/routes/realtime.ts`:

- If `Upgrade` is not websocket, return status JSON including `enabled` and a disabled reason when applicable.
- Before forwarding to the Durable Object, check:
  - `SITE_ROOM` binding exists.
  - Env kill switch is not disabled.
  - Site setting is enabled.
- Do not read `siteId` from the query string. Use `c.get('siteId')`.
- Pass the required internal config to the Durable Object through internal query params or headers.

Suggested errors:

| Code | HTTP/WS close | When |
| --- | --- | --- |
| `REALTIME_NOT_AVAILABLE` | HTTP 501 | Missing `SITE_ROOM` binding |
| `REALTIME_DISABLED` | HTTP 403 | Env or site setting disabled |
| `UNAUTHORIZED` | HTTP 401 | Invalid token |

### 3. Update `SiteRoom`

In `apps/cms/src/realtime/site-room.ts`:

- Store `siteId`, `userId` and subscription limits on the session.
- When receiving `subscribe`, call an internal route/service or receive an allowlist from the Worker to check:
  - collection realtime opt-in
  - `read` permission
  - subscription count limit
- Send acknowledgement:

```json
{ "type": "subscribed", "collection": "posts" }
```

- Send errors:

```json
{ "type": "error", "code": "COLLECTION_REALTIME_DISABLED", "message": "Realtime is disabled for this collection." }
```

The Durable Object should avoid querying the database when possible. The Worker route has better DB/runtime context; the DO should remain the connection and fan-out hub.

### 4. Update `ItemService.publishRealtimeEvent`

In `apps/cms/src/services/item-service.ts`:

- Before publishing, check:
  - deployment realtime is enabled
  - site setting is enabled
  - collection meta is enabled
  - action is included in `meta.realtime.events` if specified
- Use the same shard key as the realtime route. The route currently supports multi-region shard keys, while publish uses `idFromName(siteId)`. Move DO resolution into a shared helper so connections and publish requests reach the same room.
- Publish after the DB commit and after data has been decrypted/masked as appropriate.

Realtime errors must never fail the primary mutation.

### 5. Permissions and field masks

The MVP can check `read` permission on subscribe. The complete version needs to mask payloads per subscriber before delivery:

- Load the subscriber permission.
- Re-evaluate the row rule against the item after mutation.
- If it no longer matches, send a virtual `delete`.
- If it matches, mask fields by permission and send the `event`.

Because the Durable Object does not have convenient DB context, there are two paths:

| Path | Pros | Cons |
| --- | --- | --- |
| Worker pre-computes payloads by permission group and publishes multiple envelopes | Simple DO, no DB query inside DO | Requires grouping subscribers by permission fingerprint |
| DO calls a Worker internal API to authorize each event | Accurate and easy to reason about | More roundtrips and latency |

Recommended Phase 1: check permission on subscribe and only publish payloads that have passed basic service masking. Phase 2: permission-aware fan-out per subscriber.

### 6. Studio UI

Add UI in the Data Model collection detail:

- `Realtime enabled` toggle.
- Event checkboxes: create, update, delete.
- `Presence enabled` toggle.

Use `PATCH /api/v1/collections/:name` and merge `meta.realtime`; do not overwrite unrelated `meta` keys.

Add a settings page section:

- Site `realtime.enabled` toggle.
- `maxConnectionsPerUser` number input.
- `maxSubscriptionsPerConnection` number input.

## Test plan

Backend tests:

- `GET /api/v1/realtime` without upgrade returns health JSON.
- Missing `SITE_ROOM` returns `REALTIME_NOT_AVAILABLE`.
- Env kill switch returns `REALTIME_DISABLED`.
- Disabled site setting returns `REALTIME_DISABLED`.
- Subscribing to a collection without opt-in returns `COLLECTION_REALTIME_DISABLED`.
- Subscribing to an opted-in collection without read access returns `FORBIDDEN`.
- Mutation for a collection without opt-in does not call DO publish.
- Mutation for an opted-in collection uses the correct DO shard key.

SDK tests:

- Reconnect restores subscriptions.
- `ping` sends `pong`.
- `subscribe()` returns an unsubscribe function.
- Presence listener receives the expected payload shape.

Manual verification:

1. Deploy Worker with `SITE_ROOM`.
2. Enable `realtime.enabled` for the site.
3. Enable `meta.realtime.enabled` for the `posts` collection.
4. Open two SDK clients.
5. Client A subscribes to `posts`.
6. Client B updates an item.
7. Client A receives the correct action/itemId event.
8. Disable collection realtime and confirm new subscriptions are rejected.

## Rollout

1. Ship env kill switch with a safe default.
2. Ship site setting default disabled.
3. Ship collection opt-in UI.
4. Enable staging for one non-sensitive collection.
5. Watch connection count, error rate and DO logs.
6. Enable production per site and collection.

## Open items

- ~~Docker realtime adapter does not exist yet~~ — shipped in `realtime-audience-channels` (see below).
- ~~Publish and connect need a shared shard resolver~~ — shipped as `resolveRoomName()` in `apps/cms/src/realtime/shard-config.ts`.
- Permission-aware per-subscriber payload masking should be a Phase 2 task if Phase 1 needs to ship quickly.

## Audience plane (end-user frontend realtime)

The sections above cover the **studio plane** — admin users (`users` table) subscribing by collection. The `realtime-audience-channels` spec (`.kiro/specs/realtime-audience-channels/`) adds a second, isolated **audience plane** for frontend end-users who live in an app-owned table (keyed by e.g. a `citizenID`), not `users`.

Key pieces:

- **Protocol** (`@lumibase/shared` `realtime/protocol.ts`): the shared `lumibase-sync-v1` Zod schema, extended with `join`/`leave` frames, a `notification` frame, `welcome.plane`, and a targeted `RealtimeEvent` envelope `{ plane, target: { userId | subjectId | channel } }`. Studio frames are byte-compatible.
- **Runtime provider** (`RealtimeProvider`, ADR-002): `runtime.realtime.publish(siteId, event)`. Cloudflare forwards to the `SiteRoom` DO; Docker publishes into an in-process hub backing a `ws` server (`apps/cms/src/realtime/node-hub.ts`) attached in `serve.ts`. Multi-node Docker (Postgres `LISTEN/NOTIFY` or Redis) is future work.
- **Fan-out** (`apps/cms/src/realtime/fan-out.ts`, `shouldDeliver`): plane → target (userId/subjectId/channel) → collection subscription. Studio-only skip-echo. Strict plane isolation.
- **Tickets** (`POST /api/v1/realtime/audience-ticket`): authz lives at the route via `resolveAudienceGrant` — it maps the authenticated frontend principal to a `subjectId` and a channel allowlist from verified claims. The signed ticket carries `plane:'public'`, `subjectId`, `channels`; the DO/hub trusts these and never reads identity from the client.
- **Notifications** (`NotificationService`): persists a `notifications` row and fans it out to the recipient's sessions (`userId` for studio, `subjectId` for public), flips `pushed`, and exposes `listUndelivered`/`markPushed` for reconnect replay.
- **SDK** (`AudienceClient`): fetches the audience ticket, joins/leaves channels, surfaces channel events + notifications, reconnects with backoff and re-joins channels.
- **Scale**: per-session rate-limit/heartbeat/idle apply to both planes; `LUMIBASE_REALTIME_MAX_CONNECTIONS_PER_SUBJECT` caps per-subject sessions; `resolveRoomName`/`subjectBucket` support audience bucket sharding (v1 defaults to a single `{siteId}:aud` room).

Design rationale: the end-user table being separate from `users` is intentional and correct. The fix for "realtime can't filter end-users" is a logical **subject** address decoupled from the user source, resolved server-side from a verified ticket — not merging tables.
