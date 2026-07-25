---
version: 1
lastUpdated: 2026-06-23T09:48:37.000Z
sourceLang: vi
translatedFrom: vi
sourceHash: 56a6f2279ce458d8
mtEngine: claude
syncStatus: machine-translated
---

# Email Service

> **Availability:** The full HTTP email module documented here — templates,
> layouts, preview, and `POST /api/v1/email/send` — ships in recent CMS images.
> Older images (reported around `0.5.0`) only carried the internal
> security-notification channel and do **not** expose the `/api/v1/email/*`
> routes; verify against your deployed image's version if `/email/send` returns
> `404`.

> Goal: provide a **shared email-sending service** at the core layer, with a template/layout store, so that both Studio and extensions can use it — or configure it entirely via env when no UI is needed.

## 1. Overall architecture

LumiBase splits email into two clear layers:

| Layer | Responsibility | Location |
|---|---|---|
| **Transport** (sends bytes) | SMTP (Nodemailer) for Docker/Node, MailChannels HTTP for Cloudflare Workers | `apps/cms/src/services/email/transport.ts` |
| **EmailService** | Picks the transport by runtime, applies default `from`/`replyTo`, exposes `send()` | `apps/cms/src/services/email/email-service.ts` |
| **Render engine** | Safely substitutes `{{var}}` (HTML-escaped by default), composes the body into a layout | `apps/cms/src/services/email/render.ts` |
| **Template/layout store** | Tables `email_templates`, `email_layouts` (site-scoped, RLS) | `packages/database/src/schema/platform.ts` |
| **HTTP module** | CRUD + preview + send under `/api/v1/email/*` | `apps/cms/src/modules/email/` |
| **UI** | Studio page to manage templates/layouts + send tests | `apps/studio/src/modules/settings/email-page.tsx` |

Send flow: caller (UI or extension) → `POST /api/v1/email/send` → module renders the template (if a `templateKey` is given) → `EmailService.send()` → the transport appropriate for the runtime → audit log (`email_sent` / `email_send_failed`).

> The legacy security-notification channel (`modules/notifications/email-channel.ts`) now **shares this transport**; it only retains a fixed subject/body template per spec (Req 13.2).

## 2. Configuration via env (no UI required)

EmailService can be configured entirely through environment variables. Add them to `apps/cms/.dev.vars` (local) or `wrangler secret put` (deploy).

| Variable | Required | Description |
|---|---|---|
| `LUMIBASE_SMTP_URL` | Docker: yes | Nodemailer-style SMTP connection string, e.g. `smtps://user:pass@smtp.example.com:465`. If unset ⇒ email runs in degraded mode (no sending). |
| `LUMIBASE_MAIL_FROM` | recommended | Default sender address. Defaults to `no-reply@lumibase.local`. |
| `LUMIBASE_MAIL_REPLY_TO` | no | Default Reply-To. |
| `LUMIBASE_MAIL_ENABLED` | no | Set to `"false"` to disable all email sending (kill switch). |
| `LUMIBASE_RUNTIME` | no | `"cloudflare"` ⇒ use MailChannels; otherwise ⇒ SMTP. Defaults to `"docker"`. |

### Transport decision

```
LUMIBASE_RUNTIME === 'cloudflare' → MailChannels (HTTP)
otherwise                         → SMTP via LUMIBASE_SMTP_URL (null if unset → degraded)
```

> **Deliverability:** on Cloudflare/MailChannels you must configure SPF/DKIM/DMARC at the DNS layer; the adapter does not check this itself. On SMTP, deliverability depends on the provider.

### Degraded mode

When there is no transport (Workers without MailChannels, or Docker without `LUMIBASE_SMTP_URL`, or `LUMIBASE_MAIL_ENABLED=false`), `EmailService.fromEnv()` returns `null`. In that case:
- `GET /api/v1/email/capabilities` returns `configured: false` so the UI can show a warning.
- `POST /api/v1/email/send` returns `503 EMAIL_NOT_CONFIGURED`.
- The teammate-invite flow **degrades silently** (it still creates the `invited` user, it just does not send mail).

## 3. Templates & layouts

- **Layout** = a reusable HTML shell, required to contain the `{{content}}` slot. Branding/header/footer/style live in one place.
- **Template** = an addressable message (`key`, e.g. `teammate_invite`) made of `subject` + `bodyHtml`, with optional `bodyText` and an optional attached layout.

### Variable syntax (render engine)

| Syntax | Behavior |
|---|---|
| `{{ name }}` | Substitute + **HTML-escape** (default, safe for untrusted variables). |
| `{{{ name }}}` | Substitute **without escaping** (only for already-trusted HTML). |
| `{{content}}` | Slot in the layout where the rendered template body is inserted. |

A variable that is referenced but absent from `variables` ⇒ renders to an empty string and is collected into `missing` (a literal `{{x}}` is never left in the mail). If there is no `bodyText`, the engine derives text/plain from the HTML automatically.

## 4. HTTP API

Mounted under `/api/v1/email/*`, **inside** the authenticated stack, gated by `requireSiteAdmin()`. Every query is scoped by `site_id`. Standard envelope `{ data }` / `{ errors: [...] }`.

| Method | Path | Description |
|---|---|---|
| GET | `/email/capabilities` | Reports the available transport + `from`. |
| GET/POST | `/email/layouts` | List / create a layout. |
| PATCH/DELETE | `/email/layouts/:id` | Edit / delete a layout. |
| GET/POST | `/email/templates` | List / create a template. |
| PATCH/DELETE | `/email/templates/:id` | Edit / delete a template. |
| POST | `/email/templates/:key/preview` | Trial render (no send), returns `{ subject, html, text, missing }`. |
| POST | `/email/send` | Render (if `templateKey`) + send. **Integration point for extensions.** |
| POST | `/email/test` | Send a test mail to an address. |

### `POST /email/send`

```jsonc
{
  "to": ["teammate@example.com"],          // required, 1..50
  "cc": ["lead@example.com"],              // optional
  "replyTo": "support@example.com",        // optional
  // choose EXACTLY ONE of the two:
  "templateKey": "teammate_invite",        // render a stored template
  "inline": { "subject": "Hi", "html": "<p>…</p>", "text": "…" },
  "variables": { "name": "Sam" }
}
```

Response: `{ data: { sent: true, subject } }`, or `502 DELIVERY_FAILED` (with `retryable`), `404 NOT_FOUND` (template), `503 EMAIL_NOT_CONFIGURED`.

## 5. Management via the UI

Studio → **Settings → Email**:
- **Status**: shows whether a transport is configured.
- **Templates**: create/edit key, subject, layout, HTML body; the **Preview** pane calls `/preview` with sample variable JSON, renders in an iframe, and warns about missing variables.
- **Layouts**: HTML shells with a `{{content}}` slot.
- **Send test**: quickly send a test mail.

## 6. Inviting a teammate (invite email)

The `POST /api/v1/users/invite` route, after creating the `invited` record, sends an email best-effort (via `ctx.waitUntil` on Workers, fire-and-forget on Node — it never breaks the invite):
- If the site has a `teammate_invite` template (enabled) ⇒ use it.
- Otherwise ⇒ use the built-in message in `apps/cms/src/modules/email/invite.ts`.

> Note: invites **in the setup wizard** still only create the record and **do not** send email — because at setup time the transport is usually not yet configured. To customize the content, create a `teammate_invite` template in Studio, then re-invite from the Users page.

## 7. Integrating from an extension

An extension does **not** send SMTP itself — it calls the core's `POST /api/v1/email/send` with a `templateKey`. See the full example at [`examples/extension-email-setup`](../../../examples/extension-email-setup/README.md) and the guide in [contributing/extension-dev.md](../contributing/extension-dev.md).

## 8. Security & notes

- Templates never embed secrets: the payload carries no password hash/token (guaranteed by the data types).
- Variables are HTML-escaped by default ⇒ avoids injection from user data.
- Every send is audited (`email_sent` / `email_send_failed`) with `templateKey`, recipient count, and subject (the body content is not logged).
