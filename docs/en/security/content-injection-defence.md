---
version: 2
lastUpdated: 2026-11-21T00:18:22.760Z
sourceLang: en
contentHash: 9c30ca4798fe43ef
codeVerified: 2026-11-21T00:18:22.760Z
codeVerifiedHash: 9c30ca4798fe43ef
codeVerifiedClaims: 16
---

# Content injection and SEO poisoning: an operator guide

In November 2026 the FBI published FLASH CC-111626-MW about Gootloader: more
than 1,000 WordPress sites, entered with stolen credentials, kept working
normally for their owners while serving lure pages to selected visitors — a
ZIP holding a JavaScript file that opened the way for ransomware. The owners'
usual checks (open the site, read the latest post) found nothing.

LumiBase is not WordPress — there is no PHP, no `xmlrpc.php`, no public
comment form, and the CMS serves JSON, not pages. But the pattern is generic:
**a valid credential, then quiet content injection that nobody notices**. This
guide covers what LumiBase does about it, what you configure, what stays your
frontend's job, and what to do on the day something looks wrong.

## 1. What LumiBase covers, and what it does not

| Area | LumiBase | Your frontend / CDN |
| --- | --- | --- |
| Who can sign in, and with what | MFA, lockout, sessions, API keys | — |
| Who can change content, pages, code | Permissions, autonomy levels, approvals | — |
| A record of every admin change | `admin_change` audit rows | — |
| Suspicious content going live | Content-integrity monitor | — |
| What a visitor or crawler is served | JSON only; no response varies by User-Agent, referrer or country | **Yours**: rendering, redirects, edge rules, Workers, cloaking |
| Search-engine view of the site | — | **Yours**: Search Console and webmaster tools |

## 2. Hardening checklist

Mapped to the control table in the FLASH:

| FLASH control | In LumiBase |
| --- | --- |
| Protect administration (phishing-resistant MFA) | Policy flag `enforceTfa` on admin and editor policies — it now holds on every route, from every client; prefer passkeys. See [User management](./user-management.md) §4f. |
| Reduce attack surface | Close self-registration if you have no public audience (site setting `auth.registration` = `{ "enabled": false }`). Review `GET /api/v1/api-keys/unused?days=90` and revoke what nobody uses; new keys expire after 90 days unless you say otherwise. Keep the setup gate on (default in production). |
| Least privilege | Grant `lumibase_pages` only to people who edit pages; scope it with a row rule. Keep extensions and API keys with admins. Agents cannot install extensions, mint keys, or change settings, roles or webhooks without a human, at any autonomy level. |
| Monitor integrity | Filter the security audit tab by `admin_change` (who changed what, from where) and `content_integrity_alert` (suspicious content that went live). |
| File-upload controls | Keep `FILE_UPLOAD_ALLOWED_MIME_TYPES` within the catalogue; archives and scripts are not uploadable by default. |
| Patching and trusted components | Extensions load only from `EXTENSION_BUNDLE_ORIGINS` with a valid signature; a bundle change is re-verified. |
| Centralise evidence | Export the audit log (`GET /api/v1/admin/security/audit-log/export`) to storage outside the CMS. |

Run `lumibase doctor --security` against your production environment; it
reports the setup gate, upload type opt-outs and the rest of the
[secure defaults](./secure-defaults.md).

Turn on the content-integrity monitor's `unpublish` action for sites where a
false positive costs less than a live lure page:

```json
{ "key": "contentIntegrity", "value": { "action": "unpublish", "allowedHosts": ["cdn.example.com"] } }
```

(`POST /api/v1/settings` as a site admin.) See
[Content integrity](./content-integrity.md).

## 3. Frontend and CDN checklist

The pages search engines index are rendered by your frontend. Check, at least
monthly and after every incident:

- **Search Console queries.** Look for terms unrelated to your site — legal
  phrases, "definition of …", betting, drugs. The FLASH lists lure terms such as
  "Zoning Government Definition" and "When did Sports Betting Become Legal in
  Virginia". Unrelated queries mean you rank for content you did not publish.
- **Indexed pages.** A sudden rise in indexed URLs, or URLs that are not in your
  sitemap, is the same signal.
- **Crawler vs browser.** Fetch a few pages with a search-engine User-Agent and
  with a normal browser, from a clean network, and compare. Any difference is
  cloaking somewhere between LumiBase and the visitor.
- **Edge inventory.** List your CDN rules, redirects, Workers / edge
  functions and their deploy history. An attacker who cannot touch the CMS can
  still add a rule here.
- **Build and deploy credentials.** Deploy hooks, build tokens and the git
  integration can change what the frontend serves; rotate them with the CMS
  credentials (§5).
- **Sitemap from published items only.** Generate it from the deliver API, so
  nothing appears in it that LumiBase does not serve as published.

### Rendering content safely (Next.js starter and others)

- Render rich text from the API's sanitised output (GraphQL `RichText.html`, an
  allowlist sanitiser) or from the JSON document — never put a plain string
  field through `dangerouslySetInnerHTML`.
- Treat the deliver API's `_seo` block as data: before you put `canonical` or
  `openGraph.url` into a `<link>` or `<meta>`, check that its host is yours.
- Do not render download links from content without an allowlist of hosts.

## 4. What to watch

| Signal | Where |
| --- | --- |
| Unexpected admin changes (extensions, webhooks, flows, settings, keys, users) | Audit filter `admin_change` |
| Download links, off-site canonical URLs, publish bursts, an account's first publish | Audit filter `content_integrity_alert` |
| Everything that went live, by account | Settings → Content integrity, and the weekly "What went live this week" notification |
| Failed logins, lockouts, logins from new places | Audit events `login_failed`, `user_locked`, `anomaly_triggered` |
| Agent actions waiting for approval that nobody asked for | Mission Control → approvals |
| Search queries you do not recognise | Search Console (§3) |

## 5. Response runbook

When you suspect injected content:

1. **Stop changes.** Engage the agent kill switch for the site
   (`POST /api/v1/agent/kill-switch` with `{ "scope": "site" }`). If the public
   site is serving lure content, take it offline or into maintenance at the
   frontend/CDN, and keep a copy of what it served.
2. **Preserve evidence.** Export the audit log for the period, and save the
   relevant item revisions, activity rows and your CDN / frontend logs outside
   the CMS before changing anything else.
3. **Cut access.**
   - Suspend accounts that made unexpected changes
     (`PATCH /api/v1/users/:id` with `{ "status": "suspended" }` — their
     requests are refused at once).
   - Revoke API keys you cannot vouch for (`POST /api/v1/api-keys/:id/revoke`).
   - Rotate `JWT_SECRET` to end every session if the scope is unclear.
4. **Find the entry point.** Use the `admin_change` rows (actor, IP, user agent,
   request id) and the login events. Look for new extensions, webhooks, flows,
   domains or API keys, and for policy changes that widened access.
5. **Restore content.** Revert injected items to a clean revision
   (`POST /api/v1/items/:collection/:id/revert/:revisionId`), fix or delete
   injected pages, and remove extensions, webhooks and flows you did not create.
6. **Rotate everything else that could change what visitors see.** Deploy
   hooks, git integration tokens, CDN and DNS credentials, webhook secrets and
   provider keys — from a clean machine.
7. **Re-enable with stronger defaults.** Turn on `enforceTfa` for every policy
   that can write, and the `unpublish` action of the content-integrity monitor.
8. **Report.** If LumiBase itself was the entry point, report it privately as
   described in [SECURITY.md](../../../SECURITY.md); you can also report the
   incident to the FBI field office or IC3, as the FLASH asks.
