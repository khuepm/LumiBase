# Change Feed (CDC Extension Integration)

> Spec: `.kiro/specs/cdc-extension-integration/` · Module: `apps/cms/src/modules/cdc/change-feed/`

A first-party **transactional outbox + relay** over LumiBase content mutations. Every item create/update/delete appends one immutable change event; consumers read them through a cursor-paginated pull API, HMAC-signed webhooks, or sandboxed extension subscribers — reliably, in order, with replay.

This is distinct from the ClickHouse CDC control plane (`docs/en/cdc/`), which provisions **external** Postgres→ClickHouse replication for analytics. The Change Feed is about *your* content changes reaching *your* integrations.

## 1. Architecture

```
ItemService mutation ──(same request)──▶ lumibase_cdc_change_events (outbox, append-only)
        │                                        ▲
        └─ enqueue cdc-dispatch (latency path)   │ keyset reads (occurred_at, id), 2s safety lag
                                                 │
   30s sweep (correctness backstop) ──▶ CdcDispatcher ──▶ webhook (HMAC POST)
                                                 │       └▶ extension subscriber (sandbox, 5s budget)
   GET /api/v1/cdc/events  ◀── pull consumers ───┘
```

- **Capture** — `OutboxWriter` runs in the post-mutation side-effect cluster of `ItemService`. It never throws: a failed insert emits a `cdc_event_write_failed` audit warning and the mutation proceeds. Sites without an active subscription (and without `cdc_feed.enabled`) skip the write entirely (a cached per-site flag).
- **Ordering** — event ids are nanoid (no ordering meaning). The feed's total order per site is the composite keyset `(occurred_at, id)`, with `occurred_at` stamped by Postgres `now()` — one clock. Every read path applies a **2s safety lag** so a long transaction holding an earlier `now()` cannot be overtaken and skipped.
- **Delivery semantics** — at-least-once, never exactly-once. `event.id` is the idempotency key; consumers MUST dedupe on it. A cursor only advances past a successfully delivered batch, so events are never skipped. Long-lived: on the HTTP driver (Workers) the outbox write is post-commit best-effort — reconcile by comparing item `updatedAt` against the feed if you need a hard guarantee.

## 2. Event envelope (schemaVersion 1)

```jsonc
{
  "id": "V1StGXR8_Z5jdHi6B-myT",        // idempotency key
  "type": "items.update",                 // items.<operation>
  "schemaVersion": 1,
  "siteId": "s_abc",
  "collection": "posts",
  "itemId": "itm_xyz",
  "operation": "update",                  // create | update | delete
  "occurredAt": "2026-07-11T04:12:09.123Z",
  "actor": { "type": "api_key", "id": "key_123" },  // user | api_key | agent | system
  "source": "api",                        // api | agent | flow | system
  "changedFields": ["title", "status"],  // update only
  "data": { "title": "…" },              // ONLY in snapshot mode; pii/phi masked
  "cursor": "MTc1MT…"                     // this event's keyset token — ack/resume marker
}
```

- `payloadMode: 'reference'` (default) omits `data` — the consumer re-fetches `GET /items/:collection/:id` with its own token, so its RBAC decides what it sees. `snapshot` inlines the post-mutation record with `pii`/`phi` fields already replaced by `[masked]` **before** the event was stored.
- Versioning: additive fields keep `schemaVersion: 1`; renames/removals bump it, and the previous version stays serializable for at least one minor release. `EventEnvelopeSchema` in `@lumibase/shared/schemas` is the source of truth.

## 3. Pull consumers

```bash
# First page (needs the cdc:subscribe capability — admin implies it)
curl -H "Authorization: Bearer lbk_…" -H "X-Lumi-Site: s_abc" \
  "https://cms.example.com/api/v1/cdc/events?collections=posts&limit=100"
# → { "data": [...], "meta": { "nextCursor": "…", "hasMore": true } }

# Continue from the cursor; 410 CURSOR_EXPIRED (with earliestCursor) means you
# fell behind retention — resync from scratch or from earliestCursor.
curl … "https://cms.example.com/api/v1/cdc/events?cursor=<nextCursor>"
```

Register a `kind: 'pull'` subscription to get a durable checkpoint + lag metrics, and commit it with `POST /api/v1/cdc/subscriptions/:id/ack {"cursor": "…"}`. Acks are forward-only (409 `ACK_REGRESSION` on rewind) — rewinding is what `replay` is for.

## 4. Webhook consumers

Create a webhook (Settings → Webhooks) **with a secret** — unsigned delivery is refused — then a subscription with `kind: 'webhook'` and `webhook_id`. Batches arrive as:

```
POST <webhook.url>
Content-Type: application/json
X-Lumibase-Signature: t=<unix_seconds>,v1=<hmac_sha256_hex>

{ "events": [<envelope>…], "subscription": { "id": "…", "name": "…" } }
```

Verify before trusting (constant-time compare; reject stale timestamps):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, header: string, rawBody: string, toleranceSec = 300): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]));
}
```

Failed batches retry with exponential backoff (30s·2ⁿ, 5 attempts); 10 exhausted batches in a row flip the subscription to `dead` (notification emitted). Resume only via replay.

## 5. Build your first sink connector (extension subscriber)

1. **Manifest** (`lumibase-extension.json`): type `hook`, and one `cdc:subscribe:<collection>` capability per collection (or `cdc:subscribe:*`):

```json
{
  "name": "acme/algolia-sync",
  "version": "1.0.0",
  "type": "hook",
  "entry": "dist/index.js",
  "capabilities": ["cdc:subscribe:posts", "http:fetch:acme.algolia.net"],
  "compatibleWith": ">=0.21.0"
}
```

2. **Handler** — export `cdcSubscriber` (see `defineCdcSubscriber` in `@lumibase/extension-sdk`). Make it **idempotent on `event.id`**; you will occasionally see a batch twice:

```ts
import { defineCdcSubscriber } from '@lumibase/extension-sdk';

export const cdcSubscriber = defineCdcSubscriber({
  collections: ['posts'],
  handler: async ({ events, ctx }) => {
    for (const event of events) {
      // Upsert/delete by itemId — naturally idempotent.
      await fetch(`https://acme.algolia.net/1/indexes/posts/${event.itemId}`, {
        method: event.operation === 'delete' ? 'DELETE' : 'PUT',
        body: event.operation === 'delete' ? undefined : JSON.stringify({ id: event.itemId }),
      });
      ctx.logger.info('synced', { id: event.id });
    }
  },
});
```

3. **Ship it**: build the ESM bundle → upload via Studio → admin reviews and **grants** the capabilities → enable. Enabling auto-creates the `ext:<name>` subscription; disabling pauses it (the checkpoint survives). The host filters events to your granted collections **before** the sandbox — declaring more in code grants nothing.

Reference implementation of the pattern at module scale: `apps/cms/src/modules/lumibase-firebase-sync/`.

## 6. Operate

- **Studio** → Settings → Change Feed: status/lag per subscription, recent deliveries, pause/resume/replay/dispatch-now (destructive actions confirm first).
- **Replay** (`POST /api/v1/cdc/subscriptions/:id/replay {"occurred_after": "…"}`) rewinds inside the retention window and resets `dead`/`stale` to `active` — the only path out of those states. Audited.
- **Retention** — `cdc_feed.retentionDays` site setting (default 7, range 1–90). The sweep prunes older events/deliveries; a subscription whose checkpoint falls past the floor flips to `stale` (never silently skipped).
- **AI skills** — `listCdcSubscriptions`, `getCdcSubscriptionStatus`, `createCdcSubscription`, `replayCdcSubscription` (capability `cdc:manage`), and `deleteCdcSubscription` (control-plane → HITL approval below autopilot). Same surface over MCP (`cdc_*` tools) — REST passthrough, no guard bypass.

## 7. Multi-tenancy

All three tables (`lumibase_cdc_change_events`, `lumibase_cdc_subscriptions`, `lumibase_cdc_deliveries`) carry `site_id`, are covered by `site_isolation` RLS policies, and every query filters by site. Cache flags and dispatch locks are tenant-prefixed (`cdc:feed:<siteId>:…`, `cdc:dispatch:<siteId>:<subId>`). Property tests pin the two-site smoke: site A's reads and deliveries never contain site B's events.

## 8. Settings & capabilities reference

| Key | Where | Default | Meaning |
|---|---|---|---|
| `cdc_feed.enabled` | `settings` (site) | `false` | Write outbox events even with no active subscription |
| `cdc_feed.retentionDays` | `settings` (site) | `7` | Prune window (1–90) |
| `cdc:subscribe` | role/capability | — | Read `/cdc/events`, ack checkpoints (admin implies) |
| `cdc:manage` | capability (skills) | — | Manage subscriptions via AI skills/MCP |
| `cdc:subscribe:<collection>` | extension manifest | — | Collections an extension subscriber may receive |
