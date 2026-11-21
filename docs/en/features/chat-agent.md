---
version: 2
lastUpdated: 2026-11-21T11:15:33.556Z
sourceLang: en
contentHash: b948a82ec27aa617
codeVerified: 2026-11-21T11:15:33.556Z
codeVerifiedHash: b948a82ec27aa617
codeVerifiedClaims: 14
---

# Chat agent (Slack and generic webhook)

The Content Agent can be reached from a chat tool. Mention the LumiBase app in
Slack, for example `@lumibase draft a post about our spring launch`, or send a
signed request from your own Teams or Discord bot. LumiBase runs one Copilot
turn and replies in the thread. When the action needs approval, the reply
carries **Approve** and **Reject** buttons.

Nothing a chat message does can exceed what the person behind it could do in
Studio. Each chat user is **linked** to a LumiBase user of the site, and the
turn runs **as that user**. It uses their capabilities, row and field
permissions, autonomy level and approval rules, and it leaves the same audit
trail. An approval clicked in chat is decided as the linked user who clicked
it, so a linked editor cannot approve what only an admin may.

Code: `apps/cms/src/modules/chat-agent/`. API: [API spec §12d](../api/hono-api-spec.md#12d-chat-agent-slack--generic-webhook).

## How a message is handled

1. The request signature is verified against the integration's secret
   (HMAC-SHA256 over the raw body and a timestamp; anything more than 300 s
   old is refused). An unknown or disabled integration, an integration of
   another site or provider, or a Slack event from another workspace is
   refused before any work is done.
2. The event is recorded once per integration (`lumibase_chat_events`, unique
   event key). When Slack retries a delivery, nothing runs a second time.
3. The chat user is looked up in the links. An unlinked user gets a reply
   asking them to have an admin link their account, and no model is called. A
   link counts only while its LumiBase user is still a member of the site.
4. The message runs through the same `/ai` router Studio uses, as the linked
   user: `POST /api/v1/ai/chat`. Messages in one chat thread from one user
   continue the same Copilot conversation.
5. The result is posted back. When the turn parked for approval, the reply has
   Approve and Reject buttons whose value is the approval id.
6. A button click is verified the same way. It is decided through
   `POST /api/v1/ai/approvals/:id/decide` as the **clicking** user's link, with
   that endpoint's own admin and capability checks. The original message is
   replaced with the outcome. A refusal is shown only to the person who
   clicked.

Model output is escaped before it is posted to Slack, so a reply cannot mention
`@channel` or forge a link. Replies to a slash command go only to a
`hooks.slack.com` response URL.

## Set up Slack

1. Create a Slack app for your workspace. Give it the bot scopes
   `app_mentions:read`, `chat:write` and, for a slash command, `commands`.
   Install it to the workspace, then copy the **Bot User OAuth Token**
   (`xoxb-…`) and the app's **Signing Secret**.
2. Install the integration on the site (site admin):

   ```http
   POST /api/v1/chat-agent/integrations
   { "provider": "slack", "name": "Acme Slack", "externalId": "T0123ABCD",
     "signingSecret": "<signing secret>", "botToken": "xoxb-…" }
   ```

   `externalId` is the workspace (team) id. The response lists the three
   `endpoints` to paste into the Slack app.
3. In the Slack app, set **Event Subscriptions → Request URL** to the `events`
   endpoint and subscribe to the `app_mention` bot event. Set
   **Interactivity → Request URL** to `interactions`. Optionally, create a
   slash command (for example `/lumibase`) with the `commands` URL.
4. Link each person who should use it:

   ```http
   PUT /api/v1/chat-agent/integrations/<id>/links/U0123ABCD
   { "userId": "<their LumiBase user id>" }
   ```

   The Slack user id is in their Slack profile (**Copy member ID**).

## Generic webhook (Teams, Discord, your own bot)

Install `{ "provider": "webhook", "name": "Teams bridge" }`. The response
contains `signingSecret` **once**; store it in your bot. Link your chat tool's
user ids as above. Then sign each request:

```js
const body = JSON.stringify({ userId: 'teams-29:1abc', text: 'draft a post about X', threadId: 'conv-42' });
const ts = Math.floor(Date.now() / 1000);
const mac = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
await fetch(`${base}/api/v1/chat-agent/webhook/${siteId}/${integrationId}/messages`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-lumibase-timestamp': String(ts),
    'x-lumibase-signature': `v1=${mac}`,
    'x-lumibase-delivery': deliveryId, // optional: makes the request idempotent
  },
  body,
});
```

The answer is synchronous: the Copilot result (`status`, `message`,
`approvalId` when it parked, `conversationId`) plus `threadId`. Decide an
approval with a signed
`POST …/approvals/:approvalId/decide { "userId", "decision": "approved" | "rejected" }`.
`POST /api/v1/chat-agent/integrations/:id/rotate-secret` replaces the secret,
and the old one stops verifying at once.

## Security notes

- Secrets (Slack signing secret, bot token, webhook secret) are encrypted at
  rest with `ENCRYPTION_KEY` (AES-GCM, bound to the site, the row and the
  field). They are never returned by a read, and the integration cannot be used
  without `ENCRYPTION_KEY`.
- A failed signature is answered with `401` and written to the audit log
  (`chat_agent_signature_rejected`). Installing, changing, rotating and
  deleting an integration, and linking or unlinking a user, are audited too.
- Removing a user from the site, or changing their role, applies to their very
  next chat message: capabilities are resolved on every request.

## Limits

- One tool call per message, as in the Studio Copilot. File attachments are not
  taken from chat.
- Slack replies need the bot token. Without one, a mention still runs, but the
  reply cannot be posted. Slash commands answer through the `response_url`
  instead.
- There is no Studio screen for chat integrations yet; manage them with the API
  above.

## Multi-tenancy

| Resource | Scope |
|---|---|
| `lumibase_chat_integrations`, `lumibase_chat_user_links`, `lumibase_chat_events` | `site_id` on every row and every query; all three are in the `site_isolation` RLS list (`packages/database/migrations/rls-policies.sql`). |
| Public endpoints | The site is in the path, and every query runs on `scopedDbFor(c, siteId)`. An integration id under another site's path is `404`. |
| Links | A chat user can only be linked to a member of the same site. |

## Upgrading

Migration `0046_chat_agent` adds the three tables and changes nothing that
exists. Re-apply `rls-policies.sql` after migrating, as after every upgrade.
Set `ENCRYPTION_KEY` (already required by Git integrations) before installing
an integration.
