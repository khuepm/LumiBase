import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { requireSiteAdmin } from '../../middleware/site-admin';
import { AuditLogger } from '../audit/logger';
import { CHAT_PROVIDERS, ChatAgentError, ChatIntegrationService, type ChatProvider } from './service';
import { encryptionKeyOf, errorBody, validation } from './routes';

/**
 * Chat agent admin surface (#711): `/api/v1/chat-agent/integrations…`.
 * Mounted on the authenticated `api` (tenant → auth → db → RLS), site admins
 * only. The public, signature-verified surface is in `routes.ts`.
 */
export const chatAgentRouter = new Hono<AppEnv>();
chatAgentRouter.use('*', requireSiteAdmin());

// ── Admin: install and link ───────────────────────────────────────────────

const createSchema = z.object({
  provider: z.enum(CHAT_PROVIDERS),
  name: z.string().trim().min(1).max(120),
  externalId: z.string().regex(/^[A-Z0-9]{3,32}$/, 'externalId is the Slack workspace (team) id, e.g. T0123ABCD').optional(),
  signingSecret: z.string().min(16).max(256).optional(),
  botToken: z.string().regex(/^xoxb-[A-Za-z0-9-]{10,500}$/, 'botToken must be a Slack bot token (xoxb-…)').optional(),
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  externalId: z.string().regex(/^[A-Z0-9]{3,32}$/).optional(),
  signingSecret: z.string().min(16).max(256).optional(),
  botToken: z.string().regex(/^xoxb-[A-Za-z0-9-]{10,500}$/).nullable().optional(),
}).strict();

const linkSchema = z.object({ userId: z.string().min(1).max(64) }).strict();

function adminService(c: Context<AppEnv>): ChatIntegrationService {
  return new ChatIntegrationService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    encryptionKey: encryptionKeyOf(c),
    userId: c.get('auth').userId ?? null,
  });
}

async function audit(c: Context<AppEnv>, event: string, metadata: Record<string, unknown>): Promise<void> {
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    siteId: c.get('siteId'),
    event,
    actorEmail: c.get('auth').email ?? null,
    metadata: { ...metadata, actorUserId: c.get('auth').userId ?? null },
    requestId: c.get('requestId') ?? null,
  });
}

/** The URLs to paste into the Slack app config or the bot. */
function endpointsFor(c: Context<AppEnv>, provider: ChatProvider, id: string): Record<string, string> {
  const base = `${new URL(c.req.url).origin}/api/v1/chat-agent/${provider}/${encodeURIComponent(c.get('siteId'))}/${id}`;
  return provider === 'slack'
    ? { events: `${base}/events`, commands: `${base}/commands`, interactions: `${base}/interactions` }
    : { messages: `${base}/messages`, decide: `${base}/approvals/{approvalId}/decide` };
}

function handleError(c: Context<AppEnv>, err: unknown): Response {
  if (err instanceof ChatAgentError) return c.json(errorBody(err.code, err.message), err.status);
  throw err;
}

chatAgentRouter.get('/integrations', async (c) => {
  try {
    const list = await adminService(c).list();
    return c.json({ data: list.map((row) => ({ ...row, endpoints: endpointsFor(c, row.provider, row.id) })) });
  } catch (err) {
    return handleError(c, err);
  }
});

chatAgentRouter.post('/integrations', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(validation(parsed.error.issues), 400);
  try {
    const created = await adminService(c).create(parsed.data);
    await audit(c, 'chat_integration_created', { integrationId: created.integration.id, provider: created.integration.provider });
    return c.json({
      data: {
        ...created.integration,
        endpoints: endpointsFor(c, created.integration.provider, created.integration.id),
        // Shown once: the webhook caller signs with it. Not readable later.
        ...(created.signingSecret ? { signingSecret: created.signingSecret } : {}),
      },
    }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

chatAgentRouter.patch('/integrations/:id', async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(validation(parsed.error.issues), 400);
  try {
    const updated = await adminService(c).update(c.req.param('id'), parsed.data);
    await audit(c, 'chat_integration_updated', {
      integrationId: updated.id,
      fields: Object.keys(parsed.data),
    });
    return c.json({ data: { ...updated, endpoints: endpointsFor(c, updated.provider, updated.id) } });
  } catch (err) {
    return handleError(c, err);
  }
});

chatAgentRouter.post('/integrations/:id/rotate-secret', async (c) => {
  try {
    const signingSecret = await adminService(c).rotateWebhookSecret(c.req.param('id'));
    await audit(c, 'chat_integration_secret_rotated', { integrationId: c.req.param('id') });
    return c.json({ data: { signingSecret } });
  } catch (err) {
    return handleError(c, err);
  }
});

chatAgentRouter.delete('/integrations/:id', async (c) => {
  try {
    await adminService(c).remove(c.req.param('id'));
    await audit(c, 'chat_integration_deleted', { integrationId: c.req.param('id') });
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return handleError(c, err);
  }
});

chatAgentRouter.get('/integrations/:id/links', async (c) => {
  try {
    return c.json({ data: await adminService(c).listLinks(c.req.param('id')) });
  } catch (err) {
    return handleError(c, err);
  }
});

chatAgentRouter.put('/integrations/:id/links/:externalUserId', async (c) => {
  const parsed = linkSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(validation(parsed.error.issues), 400);
  const externalUserId = c.req.param('externalUserId');
  if (!externalUserId || externalUserId.length > 128) return c.json(errorBody('VALIDATION', 'externalUserId must be 1-128 characters.'), 400);
  try {
    await adminService(c).link(c.req.param('id'), externalUserId, parsed.data.userId);
    await audit(c, 'chat_user_linked', { integrationId: c.req.param('id'), externalUserId, userId: parsed.data.userId });
    return c.json({ data: { externalUserId, userId: parsed.data.userId } });
  } catch (err) {
    return handleError(c, err);
  }
});

chatAgentRouter.delete('/integrations/:id/links/:externalUserId', async (c) => {
  try {
    const removed = await adminService(c).unlink(c.req.param('id'), c.req.param('externalUserId'));
    if (!removed) return c.json(errorBody('NOT_FOUND', 'No such link.'), 404);
    await audit(c, 'chat_user_unlinked', { integrationId: c.req.param('id'), externalUserId: c.req.param('externalUserId') });
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return handleError(c, err);
  }
});
