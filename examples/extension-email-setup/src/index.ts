/**
 * Example LumiBase extension: email-setup.
 *
 * Illustrates the intended split for the email feature:
 *
 *   - The EXTENSION owns the trigger and any UI. Here it exposes a tiny
 *     endpoint (`POST /extensions/email-setup/notify`) that an external
 *     system — or a Studio panel you build — calls when it wants to send mail.
 *   - LUMIBASE owns the transport (SMTP / MailChannels) and the template +
 *     layout store. The extension never talks SMTP; it POSTs to LumiBase's
 *     core endpoint `POST /api/v1/email/send` with a `templateKey` and the
 *     variables the template expects.
 *
 * This keeps deliverability config (SPF/DKIM, provider secrets) and template
 * authoring centralized in LumiBase, while extensions stay thin and portable.
 *
 * The endpoint extension is loaded by the CMS extension sandbox, which injects
 * a capability-checked context. We declare `http:fetch` (to reach the core
 * email endpoint) and `env:read` (to read the LumiBase base URL + an API token
 * from EXTENSION_-prefixed env). See `manifest.json`.
 */

import { Hono } from 'hono';
import { z } from 'zod';

const app = new Hono();

/** Body the trigger sends us. `to` + the template variables. */
const NotifySchema = z.object({
  to: z.array(z.string().email()).min(1),
  variables: z.record(z.unknown()).default({}),
  /** Optional override; otherwise the manifest config `templateKey` is used. */
  templateKey: z.string().optional(),
});

/**
 * Configuration the host provides via EXTENSION_-prefixed env (read through
 * the sandbox `env:read` capability). In a real deployment these come from
 * `wrangler secret put EXTENSION_LUMIBASE_API_TOKEN` etc.
 */
const LUMIBASE_BASE_URL = process.env.EXTENSION_LUMIBASE_BASE_URL ?? 'http://localhost:1989';
const LUMIBASE_API_TOKEN = process.env.EXTENSION_LUMIBASE_API_TOKEN ?? '';
const LUMIBASE_SITE_ID = process.env.EXTENSION_LUMIBASE_SITE_ID ?? '';
const DEFAULT_TEMPLATE_KEY = process.env.EXTENSION_EMAIL_TEMPLATE_KEY ?? 'teammate_invite';

app.post('/extensions/email-setup/notify', async (c) => {
  const parsed = NotifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.format() }, 400);
  }
  const { to, variables, templateKey } = parsed.data;

  // Hand off to LumiBase's core EmailService. The extension does NOT render or
  // send mail itself — it asks LumiBase to render the stored template and
  // deliver it through the configured transport.
  const res = await fetch(`${LUMIBASE_BASE_URL}/api/v1/email/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(LUMIBASE_API_TOKEN ? { Authorization: `Bearer ${LUMIBASE_API_TOKEN}` } : {}),
      ...(LUMIBASE_SITE_ID ? { 'x-site-id': LUMIBASE_SITE_ID } : {}),
    },
    body: JSON.stringify({
      to,
      templateKey: templateKey ?? DEFAULT_TEMPLATE_KEY,
      variables,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    data?: { sent: boolean; subject: string };
    errors?: Array<{ code: string; message?: string }>;
  };

  if (!res.ok) {
    return c.json(
      { sent: false, error: body.errors?.[0]?.message ?? body.errors?.[0]?.code ?? `HTTP ${res.status}` },
      res.status as 400,
    );
  }
  return c.json({ sent: true, subject: body.data?.subject });
});

// Run as a standalone dev server when executed directly.
const port = Number(process.env.PORT) || 3006;
console.log(`[email-setup extension] Listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
