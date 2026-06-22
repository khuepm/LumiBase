# Push Notifications

LumiBase pushes operational events to Studio operators the moment they happen,
over two transports:

1. **In-app realtime** — the per-site `SiteRoom` Durable Object broadcasts a
   `notification` frame to every connected Studio WebSocket session. Cloudflare
   only; a graceful no-op on Docker and in background contexts.
2. **Web Push** — encrypted delivery (VAPID, RFC 8291/8292) to every browser
   that opted in, so an operator is reached **even with the tab closed**.

Both are **best-effort and non-blocking**: a failure in either never affects the
request that produced the event. The Mission-Control inbox poll (60s) remains
the fallback, so no event is lost — push only lowers latency.

## Events

| Kind | Fired when | Severity |
|---|---|---|
| `approval` | A HITL approval is created (reviewer needed). | info |
| `veto` | A write is staged into an L3 veto window. | warning |
| `incident` | An `agent_incidents` row is recorded. | warning / critical |
| `run` | An agent run succeeds or fails. | info / warning |
| `goal` | A parent goal settles to completed/failed. | info / warning |

Each notification carries `{ id, kind, severity, title, body, deepLink,
entityId, ts }` — identical on both transports for client-side dedupe.

## Architecture

- **Broadcaster** — `apps/cms/src/modules/notifications/agent-notifications.ts`
  (`emitAgentNotification`). Producers that only hold `db` + `siteId` accept an
  optional `AgentNotifier` callback; request-context callers build one with
  `buildAgentNotifier(c)` (`notify-context.ts`), which binds the DO namespace
  (`SITE_ROOM`) and the VAPID env. Background callers omit it (poll fallback).
- **Web Push crypto** — `apps/cms/src/modules/notifications/web-push.ts`,
  implemented entirely on the Web Crypto API so it runs on both Cloudflare
  Workers and Node (the `web-push` npm package is Node-only and is deliberately
  not used).
- **SiteRoom** — `apps/cms/src/realtime/site-room.ts` exposes
  `/publish-notification` and broadcasts the `notification` frame to all
  sessions for the site (not collection-scoped, not echo-suppressed).
- **Subscriptions** — stored in `push_subscriptions` (`site_id`, `user_id`,
  `endpoint`, `p256dh`, `auth`), one row per browser per site. Endpoints the
  push service reports as gone (404/410) are pruned on the next fan-out.
- **Studio** — `public/sw.js` (service worker), `src/lib/push.ts` (enrolment),
  and the bell in `src/components/notifications-panel.tsx` (in-app feed +
  enable/disable toggle).

## API

All under the authenticated, tenant-scoped `/api/v1`:

- `GET /api/v1/push/vapid-public-key` — returns `{ data: { publicKey } }`, or
  `404 PUSH_NOT_CONFIGURED` when VAPID keys are unset.
- `POST /api/v1/push/subscriptions` — body `{ endpoint, keys: { p256dh, auth } }`;
  upserts the caller's subscription for the active site.
- `DELETE /api/v1/push/subscriptions` — body `{ endpoint }`; removes it.

## Configuration

Web Push requires a VAPID key pair, supplied as secrets/env vars:

```
VAPID_PUBLIC_KEY    base64url of the raw 65-byte P-256 public point
VAPID_PRIVATE_KEY   base64url of the 32-byte private scalar (d)
VAPID_SUBJECT       contact URI, e.g. mailto:ops@yourdomain.com
```

Generate a pair (no extra dependencies — uses Web Crypto):

```bash
node apps/cms/scripts/generate-vapid-keys.mjs mailto:ops@yourdomain.com
```

Store the output as secrets:

- **Cloudflare:** `wrangler secret put VAPID_PRIVATE_KEY` (and `VAPID_PUBLIC_KEY`,
  `VAPID_SUBJECT`); the `SITE_ROOM` Durable Object binding must also be present
  for in-app realtime.
- **Docker / Node:** set the three env vars in the container environment.

When VAPID keys are absent, Web Push is disabled end to end (the Studio toggle
hides, the public-key endpoint returns 404, the broadcaster skips the push leg)
— in-app realtime still works wherever `SITE_ROOM` is bound.

## Runtime behaviour

| | Cloudflare | Docker / Node |
|---|---|---|
| In-app realtime (`SITE_ROOM`) | ✅ | ➖ (no DO; poll fallback) |
| Web Push (VAPID set) | ✅ | ✅ |
| Inbox poll fallback | ✅ | ✅ |

> NOTE: end-to-end Web Push delivery depends on a live push service
> (FCM/Mozilla/etc.) and valid VAPID keys, so it cannot be exercised in an
> offline test harness. The deterministic crypto (base64url, VAPID JWT signing,
> the RFC 8291 message header) is covered by unit tests in
> `apps/cms/src/modules/notifications/__tests__/web-push.test.ts`.
