/**
 * Email module HTTP surface (`/api/v1/email/*`).
 *
 * Mounted INSIDE the authenticated `/api/v1` stack (unlike the public setup
 * wizard), gated by `requireSiteAdmin()` like webhooks/settings. Every handler
 * is site-scoped via `c.get('siteId')` (Strict Rule #2) and uses the project
 * response envelope (`{ data }` / `{ errors: [...] }`).
 *
 * Routes:
 *   GET    /email/capabilities          — transport availability for the UI.
 *   GET    /email/layouts               — list layouts.
 *   POST   /email/layouts               — create layout.
 *   PATCH  /email/layouts/:id           — update layout.
 *   DELETE /email/layouts/:id           — delete layout.
 *   GET    /email/templates             — list templates.
 *   POST   /email/templates             — create template.
 *   PATCH  /email/templates/:id         — update template.
 *   DELETE /email/templates/:id         — delete template.
 *   POST   /email/templates/:key/preview — render without sending.
 *   POST   /email/send                  — render (if templateKey) + send. Extension entry point.
 *   POST   /email/test                  — send a one-off test mail.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { requireSiteAdmin } from '../../middleware/site-admin';
import { AuditLogger } from '../audit/logger';
import { EmailService } from '../../services/email/email-service';
import {
  AllRecipientsSuppressedError,
  EmailModuleService,
  EmailNotConfiguredError,
  TemplateNotFoundError,
} from './service';
import { SuppressionService } from './suppression';
import { normalizeEmail } from '../login-guard/email-normalize';
import {
  layoutCreateSchema,
  layoutUpdateSchema,
  previewSchema,
  sendSchema,
  templateCreateSchema,
  templateUpdateSchema,
  testSchema,
} from './validation';

export const emailRouter = new Hono<AppEnv>();
emailRouter.use('*', requireSiteAdmin());

/** Build the module service from the request context. */
function buildService(c: Context<AppEnv>) {
  return new EmailModuleService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    emailService: EmailService.fromEnv(c.env),
  });
}

// ── Capabilities ────────────────────────────────────────────────────────

emailRouter.get('/capabilities', (c) => {
  return c.json({ data: buildService(c).capabilities() });
});

// ── Layouts ───────────────────────────────────────────────────────────────

emailRouter.get('/layouts', async (c) => {
  return c.json({ data: await buildService(c).listLayouts() });
});

emailRouter.post('/layouts', async (c) => {
  const input = layoutCreateSchema.parse(await c.req.json());
  const row = await buildService(c).createLayout(input);
  return c.json({ data: row }, 201);
});

emailRouter.patch('/layouts/:id', async (c) => {
  const input = layoutUpdateSchema.parse(await c.req.json());
  const row = await buildService(c).updateLayout(c.req.param('id'), input);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

emailRouter.delete('/layouts/:id', async (c) => {
  const row = await buildService(c).deleteLayout(c.req.param('id'));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
});

// ── Templates ───────────────────────────────────────────────────────────

emailRouter.get('/templates', async (c) => {
  return c.json({ data: await buildService(c).listTemplates() });
});

emailRouter.post('/templates', async (c) => {
  const input = templateCreateSchema.parse(await c.req.json());
  const row = await buildService(c).createTemplate(input);
  return c.json({ data: row }, 201);
});

emailRouter.patch('/templates/:id', async (c) => {
  const input = templateUpdateSchema.parse(await c.req.json());
  const row = await buildService(c).updateTemplate(c.req.param('id'), input);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

emailRouter.delete('/templates/:id', async (c) => {
  const row = await buildService(c).deleteTemplate(c.req.param('id'));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
});

emailRouter.post('/templates/:key/preview', async (c) => {
  const { variables } = previewSchema.parse(await c.req.json().catch(() => ({})));
  try {
    const rendered = await buildService(c).render(c.req.param('key'), variables);
    return c.json({ data: rendered });
  } catch (err) {
    if (err instanceof TemplateNotFoundError) {
      return c.json({ errors: [{ code: 'NOT_FOUND', message: err.message }] }, 404);
    }
    throw err;
  }
});

// ── Send + test ─────────────────────────────────────────────────────────

emailRouter.post('/send', async (c) => {
  const input = sendSchema.parse(await c.req.json());
  return handleSend(c, {
    to: input.to,
    cc: input.cc,
    replyTo: input.replyTo,
    templateKey: input.templateKey,
    inline: input.inline,
    variables: input.variables,
  });
});

emailRouter.post('/test', async (c) => {
  const input = testSchema.parse(await c.req.json());
  if (input.templateKey) {
    return handleSend(c, {
      to: [input.to],
      templateKey: input.templateKey,
      variables: input.variables,
    });
  }
  // No template → a fixed diagnostic message so "send test" works before any
  // template exists.
  return handleSend(c, {
    to: [input.to],
    inline: {
      subject: '[LumiBase] Test email',
      text: 'This is a test email from LumiBase. Your email transport is configured correctly.',
      html: '<p>This is a test email from LumiBase. Your email transport is configured correctly.</p>',
    },
    variables: {},
  });
});

// ── Suppression list (unsubscribe / opt-out) ─────────────────────────────

emailRouter.get('/suppressions', async (c) => {
  const rows = await new SuppressionService({ db: c.get('db') }).list({
    siteId: c.get('siteId'),
  });
  return c.json({ data: rows });
});

emailRouter.post('/suppressions', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: unknown;
    reason?: unknown;
  };
  const email = normalizeEmail(typeof body.email === 'string' ? body.email : '');
  if (!email || !email.includes('@')) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'A valid email is required.' }] }, 400);
  }
  const reason = typeof body.reason === 'string' ? body.reason : 'manual';
  await new SuppressionService({ db: c.get('db') }).suppress({
    siteId: c.get('siteId'),
    email,
    reason,
    source: 'admin',
  });
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event: 'email_suppressed',
    actorEmail: c.get('auth')?.email ?? null,
    targetEmail: email,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { reason, source: 'admin' },
  });
  return c.json({ data: { email, suppressed: true } }, 201);
});

emailRouter.delete('/suppressions/:email', async (c) => {
  const email = normalizeEmail(decodeURIComponent(c.req.param('email')));
  const removed = await new SuppressionService({ db: c.get('db') }).unsuppress({
    siteId: c.get('siteId'),
    email,
  });
  if (!removed) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event: 'email_unsuppressed',
    actorEmail: c.get('auth')?.email ?? null,
    targetEmail: email,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { source: 'admin' },
  });
  return c.json({ data: null });
});

// ── Shared send handler (render + send + audit) ──────────────────────────

async function handleSend(
  c: Context<AppEnv>,
  input: {
    to: readonly string[];
    cc?: readonly string[];
    replyTo?: string;
    templateKey?: string;
    inline?: { subject: string; html?: string; text?: string };
    variables: Record<string, string | number | boolean | null>;
  },
) {
  const service = buildService(c);
  const audit = new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') });
  const auditBase = {
    actorEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
  };

  try {
    const { result, rendered } = await service.send(input);
    await audit.write({
      event: result.ok ? 'email_sent' : 'email_send_failed',
      ...auditBase,
      metadata: {
        templateKey: input.templateKey ?? null,
        recipients: input.to.length,
        subject: rendered.subject,
        ...(result.ok ? {} : { error: result.error, retryable: result.retryable }),
      },
    });
    if (result.ok) {
      return c.json({ data: { sent: true, subject: rendered.subject } });
    }
    return c.json(
      { errors: [{ code: 'DELIVERY_FAILED', message: result.error, details: { retryable: result.retryable } }] },
      502,
    );
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) {
      return c.json({ errors: [{ code: 'EMAIL_NOT_CONFIGURED', message: err.message }] }, 503);
    }
    if (err instanceof AllRecipientsSuppressedError) {
      return c.json({ errors: [{ code: 'ALL_RECIPIENTS_SUPPRESSED', message: err.message }] }, 409);
    }
    if (err instanceof TemplateNotFoundError) {
      return c.json({ errors: [{ code: 'NOT_FOUND', message: err.message }] }, 404);
    }
    throw err;
  }
}
