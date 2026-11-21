---
version: 3
lastUpdated: 2026-11-21T03:52:31.907Z
sourceLang: en
contentHash: 241fbe6d9887f2d1
codeVerified: 2026-11-21T03:52:31.907Z
codeVerifiedHash: 241fbe6d9887f2d1
codeVerifiedClaims: 8
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
| `first_publish_by_principal` | A user account takes an item live for the first time and no other published item on the site was last written by that account. A stolen or long-dormant account's first publish is worth a look. API keys, agents and system writes are not checked. |

"The site's own" hosts are the site's domains (`/api/v1/domains`) plus
`allowedHosts`, compared by registrable domain, so `cms.acme.com` and
`www.acme.com` count as one site. On a shared hosting suffix (`pages.dev`,
`workers.dev`, `github.io`, `vercel.app`, `netlify.app` and similar) each
subdomain is its own site: `acme.pages.dev` does not treat `attacker.pages.dev`
as its own. Only the host, file extension and field path are recorded — never
the content.

## What happens

Every write that raises a signal writes one `content_integrity_alert` audit
row (collection, item id, signals, action, actor type, user id, agent run id).
Filter Studio's security audit tab by `content_integrity_alert`, or the audit
log API with `?event=content_integrity_alert`.

Under the `unpublish` policy, an item carrying a `download_link` or
`offsite_seo_url` signal is set back to `draft` before the write returns; its
revision is kept and an `integrity_unpublish` activity row records it. A
`publish_burst` or `first_publish_by_principal` only notifies: volume or novelty alone is not proof. Pages have no draft
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
  "burstWindowMinutes": 10,
  "firstPublishSignal": true,
  "weeklyDigest": true
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` turns the monitor off for the site. |
| `action` | `notify` | `notify` or `unpublish`. |
| `allowedHosts` | `[]` | Extra hosts that count as the site's own (a CDN, a download server). |
| `burstThreshold` | `25` | First publishes in the window before a burst alert. |
| `burstWindowMinutes` | `10` | Burst window. |
| `firstPublishSignal` | `true` | `false` turns off `first_publish_by_principal`. |
| `weeklyDigest` | `true` | `false` stops the weekly "what went live" notification. |

Studio edits all of this in **Settings → Content integrity**.

## What went live: the digest

The scan only sees what it has a rule for. The digest is the check that does
not depend on it: everything that went live, so a person can ask "do I
recognise this?".

- `GET /api/v1/admin/security/content-integrity/digest?days=7` (site admins;
  `days` from 1 to 31) returns the items first published in the window, the
  count per account that last wrote them (`published.byPrincipal`, with
  emails), the latest 100 of them (`published.items`), and the window's alerts
  by signal (`alerts.bySignal`). **Settings → Content integrity** shows the
  last 7 days.
- Once every 7 days, from the hourly scheduled job (Node and Workers), each
  site administrator gets a Studio notification, "What went live this week",
  with the same summary (`modules/content-integrity/digest.ts`). It is skipped
  for a site where nothing went live and nothing alerted, or where `enabled`
  or `weeklyDigest` is `false`.

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
- `first_publish_by_principal` reads the item's last writer
  (`user_updated`), not a publish history: an account that only ever edited
  items someone else published counts as new. On a fresh site every
  account's first publish raises it once.
- Search indexes and realtime events emitted for the write before an
  `unpublish` are not retracted by the monitor; the next index sweep and the
  cache invalidation that follows the write correct them.
