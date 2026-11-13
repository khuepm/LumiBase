---
version: 1
lastUpdated: 2026-11-13T15:31:03.856Z
sourceLang: en
contentHash: 3b14ce684d73bd22
codeVerified: 2026-11-13T15:31:03.856Z
codeVerifiedHash: 3b14ce684d73bd22
codeVerifiedClaims: 6
---

# Activation Milestones and Usage Telemetry

This page covers two separate things that are easy to confuse:

- **Activation milestones** are stored in your own database and read by your own site admins. They never leave the install.
- **Usage telemetry** is an optional emitter that reports install-level milestones to an endpoint you name. It is **off by default** and there is no built-in endpoint.

## Activation milestones

Each site has four milestones, in order:

| Milestone | Reached when | Timestamp comes from |
|---|---|---|
| `site_created` | The site exists | `lumibase_sites.created_at` |
| `item_published` | The site has a published item | Earliest `updated_at` among the site's published, non-deleted `lumibase_items` when the milestone is first derived |
| `delivery_request` | A client reads content successfully for the first time | Recorded at the moment of the request |
| `agent_run` | The site has an agent run | Earliest `lumibase_agent_runs.started_at` |

`delivery_request` counts a `GET` answered `2xx` or `304` on either surface:

- `/api/v1/deliver/*`, the public Delivery API;
- `/api/v1/items/*` when the caller authenticates with an API key. Reads made by a signed-in user do not count.

Milestones are write-once. They are stored in `lumibase_activation_milestones`, one row per site and milestone, and deleting the item or run that marked a milestone does not un-reach it. `item_published` has no dedicated column to read, so its timestamp is an upper bound: it is the best value available when the milestone is first derived, and it is frozen from then on.

Only the timestamp is stored. No path, API key, IP address or user agent is recorded.

### Reading the funnel

```http
GET /api/v1/activation
```

Site admins only (`403 FORBIDDEN` otherwise). Returns the active site's funnel:

```json
{
  "data": {
    "siteId": "site_abc",
    "milestones": [
      { "key": "site_created", "reachedAt": "2026-10-01T08:00:00.000Z", "source": "derived", "secondsSinceSiteCreated": 0 },
      { "key": "item_published", "reachedAt": "2026-10-01T09:00:00.000Z", "source": "derived", "secondsSinceSiteCreated": 3600 },
      { "key": "delivery_request", "reachedAt": null, "source": null, "secondsSinceSiteCreated": null },
      { "key": "agent_run", "reachedAt": null, "source": null, "secondsSinceSiteCreated": null }
    ],
    "reached": 2,
    "total": 4
  }
}
```

`source` is `event` when the milestone was recorded as it happened and `derived` when it was read back from existing rows.

## Usage telemetry

### It is off unless you turn it on

Telemetry sends nothing unless **both** of these are set:

| Variable | Default | Meaning |
|---|---|---|
| `LUMIBASE_TELEMETRY_ENABLED` | (unset) | Set to `true` to opt in. |
| `LUMIBASE_TELEMETRY_ENDPOINT` | (unset) | URL that receives the events. There is no default endpoint. Must be `https:`; `http:` is accepted only for `localhost`. |

While telemetry is off the emitter does not query the database, does not generate an install id and makes no network request.

Studio never asks you to enable telemetry. The environment variables above are the only way to turn it on.

### Turning it off

Set one variable:

```bash
LUMIBASE_TELEMETRY_DISABLED=true
```

It wins over `LUMIBASE_TELEMETRY_ENABLED`. `DO_NOT_TRACK=1` has the same effect. Removing `LUMIBASE_TELEMETRY_ENABLED` also turns it off.

To remove the install id after opting out, delete the state row:

```sql
DELETE FROM lumibase_telemetry_state;
```

### What is sent

On the hourly scheduled tick, an opted-in install reports the first time **any** of its sites reaches each milestone. That is at most four requests over the lifetime of an install. Each request is an HTTP `POST` whose body is exactly this JSON object:

```json
{
  "schemaVersion": 1,
  "installId": "3f0c1e52-8a55-4b0e-9d5e-0c6f1f6f2a11",
  "event": "first_item_published",
  "occurredOn": "2026-11-02",
  "version": "2.0.0",
  "runtime": "docker"
}
```

| Field | Content |
|---|---|
| `schemaVersion` | Always `1`. |
| `installId` | A random UUID v4 generated on your install the first time telemetry runs. It is not derived from a hostname, key, user or site. |
| `event` | `first_site_created`, `first_item_published`, `first_delivery_request` or `first_agent_run`. |
| `occurredOn` | The UTC day the milestone was reached. No time of day. |
| `version` | The LumiBase version, or `unknown`. |
| `runtime` | `docker` or `cloudflare`. |

The schema is published as JSON Schema in [`docs/schemas/telemetry-event.v1.schema.json`](https://github.com/khuepm/LumiBase/blob/main/docs/schemas/telemetry-event.v1.schema.json) and as `TelemetryEventSchema` in `@lumibase/contracts`. The schema rejects unknown fields, and the emitter validates every body against it before sending.

The only request header the emitter sets is `Content-Type: application/json`. It does not follow redirects.

### What is never sent

- Content, collection names, field names or item data.
- Site ids, organization ids, domains or hostnames.
- User ids, emails, API keys or tokens.
- IP addresses, in the body or in any header set by the emitter.
- Counts of anything: how many sites, items, requests or runs.

Any HTTP request reveals the sender's network address to the receiver at the connection level. The emitter cannot prevent that; whoever operates the endpoint you configure decides whether that address is logged.

### Delivery

An event is marked as sent only after the endpoint answers `2xx`. Otherwise it is retried on a later tick. On Cloudflare Workers two overlapping ticks can deliver the same event twice with an identical body, so a collector should treat `(installId, event)` as the key.

Each sent body is also written to the server log with the prefix `[telemetry]`, so you can audit exactly what left the install.

### Relation to user consent

Per-user consent records (`/api/v1/me/consents`) govern processing of an individual user's data. Telemetry reads no per-user data and does not consult or change those records. The decision to enable it belongs to the operator of the install.

## Runtime support

Both features run on Docker and on Cloudflare Workers. The telemetry pass runs on the hourly schedule that already exists on each runtime: the `0 * * * *` Cron Trigger on Workers and the hourly cron in the Node server.
