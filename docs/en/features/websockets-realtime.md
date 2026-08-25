---
version: 1
lastUpdated: 2026-08-02T19:21:20.573Z
sourceLang: en
contentHash: 3fcc9c501310e61f
codeVerified: 2026-08-02T19:21:20.573Z
codeVerifiedHash: 3fcc9c501310e61f
codeVerifiedClaims: 4
---

# Realtime / WebSocket

Realtime lets clients receive item changes and presence updates over WebSocket. LumiBase uses Cloudflare Durable Objects as a per-site hub, while enablement is split into several layers so operators can control it safely.

## Should realtime be enabled by env or DB setting?

Use both, with different responsibilities:

| Layer | Purpose | Changed by | Recommendation |
| --- | --- | --- | --- |
| Env/binding | Infrastructure capability and deployment-level kill switch | Operator/DevOps | Use to block realtime globally or in unsupported environments |
| `settings` table | Site-level realtime toggle and limits | Site admin | Use for Studio settings |
| `collections.meta` | Collection-level realtime opt-in | Data model admin | Use to choose which collections can be subscribed to |

Default decision:

- `SITE_ROOM` binding is the required infrastructure capability on Cloudflare Workers.
- `LUMIBASE_REALTIME_ENABLED=false` is a deployment-level kill switch. When unset or `true`, the server continues to read the site setting.
- Setting `realtime.enabled` decides whether a site can use realtime.
- A collection can only be subscribed to when `collections.meta.realtime.enabled === true`.

This prevents new collections from accidentally broadcasting data in realtime.

## Site configuration

Create or update this setting:

```http
POST /api/v1/settings
Content-Type: application/json

{
  "key": "realtime.enabled",
  "value": {
    "enabled": true,
    "maxConnectionsPerUser": 5,
    "maxSubscriptionsPerConnection": 50
  }
}
```

Recommended defaults:

| Key | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | Sites must explicitly enable realtime |
| `maxConnectionsPerUser` | `5` | Resource guard per user |
| `maxSubscriptionsPerConnection` | `50` | Prevents runaway subscriptions |
| `heartbeatSeconds` | `30` | Matches the current Durable Object heartbeat |
| `idleTimeoutSeconds` | `90` | Closes silent connections |

## Enable realtime for a collection

Collections use the existing JSONB `meta` field for opt-in configuration:

```http
PATCH /api/v1/collections/posts
Content-Type: application/json

{
  "meta": {
    "realtime": {
      "enabled": true,
      "events": ["create", "update", "delete"],
      "presence": true
    }
  }
}
```

If a collection does not have `meta.realtime.enabled: true`, the server must reject `subscribe` with `COLLECTION_REALTIME_DISABLED`, and `ItemService` must not publish events for that collection.

## Endpoint

```text
wss://<cms-host>/api/v1/realtime?token=<jwt>
```

Browser WebSocket connections cannot reliably send an `Authorization` header, so the token is passed as a query parameter. The endpoint should derive `siteId` from tenant middleware and should not trust a client-supplied `siteId`.

When the request is not a WebSocket upgrade, the endpoint returns a lightweight health response:

```json
{
  "status": "realtime_ready",
  "supportedProtocols": ["lumibase-sync-v1"]
}
```

## Protocol

Client messages:

```json
{ "type": "subscribe", "collection": "posts" }
```

```json
{ "type": "unsubscribe", "collection": "posts" }
```

```json
{ "type": "presence", "collection": "posts", "itemId": "item_123", "meta": { "cursor": "title" } }
```

```json
{ "type": "pong" }
```

Server messages:

```json
{ "type": "welcome", "sessionId": "abc123" }
```

```json
{ "type": "ping" }
```

```json
{
  "type": "event",
  "collection": "posts",
  "action": "update",
  "itemId": "item_123",
  "payload": { "title": "Published" }
}
```

```json
{
  "type": "presence",
  "users": [
    {
      "sessionId": "abc123",
      "userId": "user_1",
      "collection": "posts",
      "itemId": "item_123",
      "lastSeen": "2026-06-02T10:00:00.000Z"
    }
  ]
}
```

```json
{ "type": "error", "code": "FORBIDDEN", "message": "Read access required." }
```

## SDK

```ts
import { RealtimeClient } from '@lumibase/sdk/realtime';

const realtime = new RealtimeClient({
  baseUrl: 'https://cms.example.com',
  token,
  siteId,
});

const unsubscribe = realtime.subscribe('posts', (event) => {
  console.log(event.action, event.itemId, event.payload);
});

realtime.onPresence((users) => {
  console.log(users);
});

realtime.connect();

// Later
unsubscribe();
realtime.disconnect();
```

## Permissions

The server must check permissions at two points:

1. On subscribe: the user needs `read` access to the collection.
2. On publish: payloads must be masked according to field permissions before delivery.

If a row-level rule means the user can no longer see an item after an update, the server should send a virtual `delete` event to that subscriber so the client removes the item from its local cache.

## Current limits

- Durable Object `SiteRoom` is only available on Cloudflare Workers.
- Docker runtime needs a separate WebSocket adapter before realtime can run self-hosted.
- The first phase only supports collection events and basic presence. Filtered subscriptions and collaborative editing are later phases.

See the detailed implementation plan in [Realtime WebSocket Implementation](../architecture/realtime-websocket-implementation.md).
