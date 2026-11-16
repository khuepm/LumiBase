---
version: 1
lastUpdated: 2026-11-16T02:41:48.792Z
sourceLang: en
contentHash: e70a9cab59a3f86a
codeVerified: 2026-11-16T02:41:48.792Z
codeVerifiedHash: e70a9cab59a3f86a
codeVerifiedClaims: 28
---

# Memberships & newsletters

LumiBase can run an audience: **members** with free, paid or complimentary access on a **tier**,
**newsletters** members toggle on and off, **saved segments** that keep themselves current,
automated **email sequences**, custom **sending domains** with DKIM, and an embeddable
**Portal** for sign-up, sign-in and account management (epic #672). Studio: **Settings →
Audience → Members & newsletters** (`/settings/audience`).

Payments are not processed here: a paid tier carries prices and payment-provider ids, and a
checkout hook is left for the payment integration.

## Members and tiers

A member is the audience record of one person on one site: email, name, `status`
(`free` | `paid` | `comped`), tier, labels, newsletter choices and mail activity (sent, opened,
last opened). Members created by staff or imported have no account; a member who signs in
through the Portal is linked to a **subscriber-realm** account (`frontend` session, no Studio
access — see [user management](../security/user-management.md)).

| Status | Tier | Set by |
|---|---|---|
| `free` | the site's free tier (created on first use) | sign-up, staff, a free-tier switch |
| `paid` | a paid tier | the payment hook (staff can set it too) |
| `comped` | a paid tier, no payment | staff |

**Tier-gated content uses the permission engine.** Each tier owns an ordinary policy
(`policies.key = member-tier:<key>`, no admin or Studio access). When a member with an account
holds a live tier, that policy is attached to the account for this site (`user_policies`);
changing tier, a lapsed `tierExpiresAt`, or deleting the member detaches it, and the permission
version is bumped so the change applies on the next request. Grant read on a collection with
`PUT /api/v1/members/tiers/:id/access`, or shape the policy in **Access → Policies** like any
other (for example a `visibility` field filter). Content every signed-in member may read belongs
on the `subscriber` realm grant (`POST /api/v1/users/subscriber-access`).

A free member's paid-only newsletters are dropped when they move down to `free`.

## Member Portal

The Portal is off until **Portal → Enable the member Portal** is on. Its public API is
`/api/v1/portal/*`:

1. `POST /api/v1/portal/magic-link` `{ email, name?, newsletters?, redirectUri?, intent }` answers
   the same `202` whether or not the address is a member (a sign-in for an unknown address sends
   nothing). The link goes to a landing URL the site registered (**exact match**, the same rule as
   social login), with `?lumi_member_token=…`. Only the SHA-256 of the token is stored; it works
   once and expires after 24 hours. Requests are braked per IP and limited to 5 links per address
   per 15 minutes.
2. The landing page posts the token to `POST /api/v1/portal/magic-link/verify`. One conditional
   update consumes it, so a link mints at most one session. Sign-up creates the free member,
   subscribes the chosen (or default) newsletters, provisions a passwordless subscriber account
   and returns a `frontend` session — the same shape as `/auth/login`.
3. With that session, `GET/PATCH/DELETE /api/v1/portal/me` reads the profile, toggles newsletters,
   unsubscribes from everything or leaves; `POST /api/v1/portal/me/tier` switches to a free tier or
   asks the payment hook for a checkout URL (`402 PAYMENT_PROVIDER_NOT_CONFIGURED` without one).

A magic link never becomes a way around a password and second factor: when the address belongs
to an account that is more than a subscriber (a staff role on any site, the bootstrap admin, or
an enrolled second factor), the member is verified but no session is issued
(`409 PASSWORD_LOGIN_REQUIRED`).

### Portal widget

`@lumibase/portal` renders the sign-up card and the account view (newsletter toggles, tier
switch, sign out). It works three ways:

```html
<!-- Plain HTML: the script defines <lumi-portal> and mounts every [data-lumi-portal] -->
<script src="https://unpkg.com/@lumibase/portal/dist/portal.min.js" defer></script>
<lumi-portal api="https://cms.example.com" site="site_1" locale="vi"
             redirect-uri="https://blog.example.com/welcome" newsletters="weekly"></lumi-portal>
```

```tsx
// React / Next.js (client component)
import { LumiPortal } from '@lumibase/portal/react';

<LumiPortal url="https://cms.example.com" siteId="site_1" locale="vi" redirectUri="https://blog.example.com/welcome" />;
```

```ts
import { mountPortal } from '@lumibase/portal';

mountPortal(document.getElementById('portal'), { url: 'https://cms.example.com', siteId: 'site_1' });
```

On the landing page the widget reads `lumi_member_token`, strips it from the address bar, redeems
it and stores the session (in memory when storage is blocked). Missing options, a malformed
landing URL or a malformed `copy` attribute render nothing or fall back to defaults — the widget
never throws into the host page, and server strings are set as text, never as HTML. Theme it with
CSS custom properties: `--lumi-portal-accent`, `--lumi-portal-accent-text`, `--lumi-portal-text`,
`--lumi-portal-muted`, `--lumi-portal-border`, `--lumi-portal-bg`, `--lumi-portal-radius`,
`--lumi-portal-font`. The SDK has the same calls as commands (`requestMemberLink`,
`verifyMemberLink`, `getMember`, `updateMember`, `switchMemberTier`, `leaveMembership`).

### Signup card block

**Portal → Install signup card block** (`POST /api/v1/members/signup-card/install`) adds the
`signup_card` block template: `heading`, `description`, `placeholder`, `button_label` and
`success_message` are `translatable-text` fields, plus `newsletters`, `collect_name` and
`layout`. Copy resolves field by field: the card's own override for the locale → the site's copy
for the locale (`pt-BR`, then `pt`) → the built-in default for the locale (English and
Vietnamese ship). The widget and `GET /api/v1/portal/signup-card?locale=` use the same function
(`resolveSignupCopy` in `@lumibase/contracts/members`), so a localized page never shows a
hard-coded English placeholder. Pass a card's data to the widget with `signupCardOverrides(data)`.

## Saved segments

A segment is a named filter; its count is evaluated on every read, so it moves as members sign
up, change tier or open mail — nothing is materialised that could go stale. Studio refreshes
counts every 15 seconds.

```json
{
  "match": "all",
  "conditions": [
    { "field": "status", "op": "in", "value": ["paid", "comped"] },
    { "field": "last_email_opened_at", "op": "older_than_days", "value": 60 },
    { "field": "newsletter", "op": "subscribed", "value": "weekly" }
  ]
}
```

| Field | Operators | Value |
|---|---|---|
| `status` | `in`, `not_in` | `free` / `paid` / `comped` list |
| `tier` | `in`, `not_in` | tier keys |
| `label` | `has`, `not_has` | a label |
| `newsletter` | `subscribed`, `not_subscribed` | a newsletter key |
| `source` | `in`, `not_in` | `portal` / `admin` / `import` / `api` |
| `email_verified` | `is` | boolean |
| `created_at`, `last_seen_at`, `last_email_opened_at` | `before`, `after` (ISO date); `within_days`, `older_than_days` (days); `never` | |
| `email_count`, `email_opened_count` | `gte`, `lte`, `eq` | integer |
| `email_open_rate` | `gte`, `lte` | percent 0–100 (members never mailed match neither) |

`match: "any"` ORs the conditions. Tier and newsletter conditions are resolved on the same site
only. A segment is a newsletter audience (`segmentId` on a send), a sequence trigger
(`trigger: "segment"`) and a member-list filter (`GET /api/v1/members?segmentId=`).

## Newsletters

A newsletter is a list (`audience: members` or `paid` for paid and comped only) with a sender,
optional layout and opt-in open / click tracking. An **issue** is one item sent once:

```http
POST /api/v1/members/newsletters/:id/sends
{ "collection": "posts", "itemId": "p1", "segmentId": null, "publish": true,
  "compose": { "subjectField": "title", "bodyField": "content", "locale": "en" } }
```

- `publish: true` is **Publish & send**: the item is published first, through your own
  permissions, then read and composed. The body may be HTML (active content is stripped), plain
  text, a translatable map, or a rich-text document (rendered by the shared serializer).
- The same item cannot be sent twice with the same newsletter (`409 ALREADY_SENT`).
- The audience is the newsletter's subscribers, narrowed by the segment frozen at creation.
  Members who unsubscribe mid-send are skipped.
- Sending is batched: the request answers `202` and drives the first batches; the members tick
  resumes the rest under a lease, 100 members per batch. Each recipient gets one
  `newsletter_deliveries` row before the mail goes out, so a retry never sends twice to a member
  who already received it.
- Every message carries a per-member unsubscribe link in the body and the
  `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058).
  The site suppression list is honoured.
- With tracking on, an open pixel and signed click redirects record the first open and click per
  member (`GET /api/v1/portal/email/o`, `/c`). The click redirect only follows URLs the CMS
  signed — it is not an open redirect.
- A sender address must sit on a verified sending domain (`409 SENDER_DOMAIN_UNVERIFIED`).

Template variables: `{{member.name}}`, `{{member.first_name}}`, `{{member.email}}`,
`{{unsubscribe_url}}`, `{{post.title}}`, `{{newsletter.name}}`. When neither the body nor the
layout uses `{{unsubscribe_url}}`, a footer link is added.

## Email sequences

A sequence is an ordered list of steps (`delayMinutes` after the previous step, subject, HTML)
run per enrolled member. Three templates ship as drafts to review before activating:

| Template | Trigger | Steps |
|---|---|---|
| `welcome` | `member.created` | now, +2 days, +5 days |
| `onboarding` | `member.tier_changed` to paid / comped | now, +3 days |
| `win-back` | `segment` (e.g. no open in 60 days) | now, +7 days |

Triggers: `member.created` (optionally only some statuses), `member.tier_changed` (optionally one
tier key), `segment` (members are enrolled as they enter the segment) and `manual`. A member is
enrolled once per sequence. Enrolment stops — no further step is sent — when the member
unsubscribes from everything (Portal or one-click link), is suppressed, or is deleted.

Sequences also work with [Flows](./flows-automation.md): member events reach event-triggered
flows on collection `lumibase_members` (action `create` / `update` / `delete`, payload `event`
`member.created` / `member.tier_changed` / `member.unsubscribed` / `member.deleted`), and the
`members:enroll` operation (`sequenceKey`, `memberId` defaulting to the event's member) enrols
after the flow has branched.

## Custom sending domains

**Sending domains** (`/api/v1/email/sending-domains`) sets up a domain to send from:

| Record | Host | Value |
|---|---|---|
| SPF | `<domain>` | `v=spf1 a mx include:relay.mailchannels.net ~all` (MailChannels) or your SMTP provider's include |
| DKIM | `<selector>._domainkey.<domain>` | `v=DKIM1; k=rsa; p=<2048-bit key>` |
| DMARC | `_dmarc.<domain>` | `v=DMARC1; p=none; adkim=r; aspf=r` to start |

The 2048-bit DKIM value is longer than one 255-byte TXT string, so the wizard also gives it
pre-split into quoted chunks. **Check DNS** looks the records up (DNS over HTTPS, so it works on
both runtimes); the domain is `verified` when the DKIM key and one SPF record are published. The
DMARC check reports the policy and **alignment**: every newsletter sender on the domain must align
with `d=<domain>` under the record's `adkim` mode (strict = the exact domain). Mail from a
verified domain is DKIM-signed with its active key on SMTP and on MailChannels. Private keys are
sealed with the deployment key provider.

**Rotation without downtime.** Rotation is due 180 days after verification (or on **Rotate
DKIM**): a new key is generated under a new selector and listed next to the current one; once a
check has seen it published for more than an hour, signing switches to it, and the old selector
stays listed for 7 more days so mail signed with it still verifies. After that the wizard marks
the old record as removable.

## Multi-tenancy

Every new table has `site_id`, is in the RLS `site_isolation` list and every query is site-bound;
segment sub-selects (tiers, newsletters) repeat the site condition. Isolated per site: members,
tiers and their policies, segments, newsletters, sends, deliveries, sequences, enrolments,
sending domains and their keys, magic-link tokens and Portal settings. Shared by the deployment:
the email transport, `JWT_SECRET` (signs unsubscribe and tracking links; each token names its site
and the handler scopes its database handle to it) and the key provider (DKIM private keys are
sealed with an AAD naming site, domain and selector). The members tick runs on the system
connection across sites and takes each unit of work's `site_id` from the row it claimed.
Verified by `members.db.integration.test.ts` and `members-routes.db.integration.test.ts` (two
sites: same email and tier key on both, a magic-link token from site A refused on site B, a site-B
member never mailed by site A's send, an unsubscribe link honoured on its own site whatever host
it arrives on).

## Configuration

| Variable | Used for |
|---|---|
| `LUMIBASE_PUBLIC_URL` | Public CMS origin for unsubscribe and tracking links. Sends started from Studio fall back to the request origin; sequences need it. |
| `JWT_SECRET` | Signs member link tokens (already required). |
| `LUMIBASE_SMTP_URL` / MailChannels | Transport, as for all mail. |

The members tick runs every minute on Docker (leader-locked) and on the Workers minute trigger.
