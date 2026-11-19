---
version: 1
lastUpdated: 2026-11-19T20:13:27.584Z
sourceLang: en
contentHash: ec71b5b95a014934
codeVerified: 2026-11-19T20:13:27.584Z
codeVerifiedHash: ec71b5b95a014934
codeVerifiedClaims: 4
---

# Content integrity monitoring

LumiBase checks content when it goes live and raises an alert when it looks
like an injection (#989). The model is the campaign in FBI FLASH
CC-111626-MW: compromised sites kept working normally for their owners while
serving lure pages that handed visitors a ZIP with a JavaScript file, and
search signals that pointed somewhere else. The owner's usual checks — open
the site, read the latest post — found nothing.

## What is checked

After every write that leaves an item `published`, and after a delivery page
is created or its layout changes (`modules/content-integrity/monitor.ts`):

| Signal | Raised when |
| --- | --- |
| `download_link` | Any string in the content — plain field, nested JSON, rich text, HTML — links to an archive or executable (`.zip`, `.js`, `.exe`, `.msi`, `.iso`, `.ps1`, `.vbs`, `.jar`, `.apk`, `.dmg`, …) on a host that is not the site's own. |
| `offsite_seo_url` | A `canonical`, `og_url` / `og:url` or `twitter_url` value points at another host. Only checked once the site has at least one known host. |
| `publish_burst` | Items first published across the site in the last `burstWindowMinutes` cross `burstThreshold` (alerts at the crossing and at each further multiple, not on every publish). |

"The site's own" hosts are the site's domains (`/api/v1/domains`) plus
`allowedHosts`, compared by registrable domain, so `cms.acme.com` and
`www.acme.com` count as one site. Only the host, file extension and field path
are recorded — never the content.

## What happens

Every write that raises a signal writes one `content_integrity_alert` audit
row (collection, item id, signals, action, actor type, user id, agent run id).
Filter Studio's security audit tab by `content_integrity_alert`, or the audit
log API with `?event=content_integrity_alert`.

Under the `unpublish` policy, an item carrying a `download_link` or
`offsite_seo_url` signal is set back to `draft` before the write returns; its
revision is kept and an `integrity_unpublish` activity row records it. A
`publish_burst` only notifies: volume alone is not proof. Pages have no draft
state, so they only notify.

When the content came from an agent run, the monitor also records a
`content_integrity` incident (severity high) for the agent role on
`items:update` and `items:create`, which demotes those grants — see
[AI skills](../ai-skills.md).

## Policy

Site setting `contentIntegrity`, written by a site admin with `POST /api/v1/settings` and `{ "key": "contentIntegrity", "value": { … } }`:

```json
{
  "enabled": true,
  "action": "notify",
  "allowedHosts": ["cdn.acme-assets.net"],
  "burstThreshold": 25,
  "burstWindowMinutes": 10
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` turns the monitor off for the site. |
| `action` | `notify` | `notify` or `unpublish`. |
| `allowedHosts` | `[]` | Extra hosts that count as the site's own (a CDN, a download server). |
| `burstThreshold` | `25` | First publishes in the window before a burst alert. |
| `burstWindowMinutes` | `10` | Burst window. |

## Multi-tenancy

Everything is per site: the policy is a site setting, alerts and activity rows
carry `site_id`, the burst count and domain lookup are scoped by `site_id`.
Nothing is shared between tenants.

## Limits

- The monitor sees content stored in LumiBase. Cloaking — serving one thing to
  search crawlers and another to visitors — happens in the frontend or CDN
  that renders it, and is outside its reach. Review your search-console
  queries for terms unrelated to your site, and compare what a crawler and a
  browser receive.
- It fails open: if the check itself cannot run, the write goes through and the
  failure is logged. It never blocks a write except by the `unpublish` action.
- A bulk import that publishes many items will raise a `publish_burst` alert;
  raise `burstThreshold` for sites that publish in large batches.
- Search indexes and realtime events emitted for the write before an
  `unpublish` are not retracted by the monitor; the next index sweep and the
  cache invalidation that follows the write correct them.
