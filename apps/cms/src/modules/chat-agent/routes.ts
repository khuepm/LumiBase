import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { Database } from '@lumibase/database';
import type { AppEnv } from '../../env';
import { scopedDbFor } from '../../middleware/db';
import { AuditLogger } from '../audit/logger';
import { dispatchAsUser, type DispatchResult } from './dispatch';
import {
  CHAT_PROVIDERS,
  ChatAgentError,
  ChatIntegrationService,
  type ChatIntegrationRow,
  type ChatProvider,
} from './service';
import { verifySlackSignature, verifyWebhookSignature } from './signatures';
import {
  APPROVE_ACTION,
  REJECT_ACTION,
  copilotReply,
  escapeMrkdwn,
  postMessage,
  respond,
  stripMentions,
  type SlackMessage,
} from './slack';

/**
 * Chat agent (#711) — the Content Agent from Slack, and from any chat tool
 * through a signed generic webhook.
 *
 * Public, signature-verified surface (mounted pre-auth; the site and the
 * integration are in the path, every query runs on `scopedDbFor(siteId)`):
 *
 *   POST /api/v1/chat-agent/slack/:siteId/:integrationId/events        app_mention
 *   POST /api/v1/chat-agent/slack/:siteId/:integrationId/commands      slash command
 *   POST /api/v1/chat-agent/slack/:siteId/:integrationId/interactions  Approve / Reject buttons
 *   POST /api/v1/chat-agent/webhook/:siteId/:integrationId/messages
 *   POST /api/v1/chat-agent/webhook/:siteId/:integrationId/approvals/:approvalId/decide
 *
 * Admin surface: `admin-routes.ts` (`/api/v1/chat-agent/integrations…`).
 *
 * Every chat request runs AS the LumiBase user its chat user is linked to
 * (see dispatch.ts). An unlinked chat user can do nothing but read the
 * "ask an admin to link you" reply. Unknown, disabled or other-provider
 * integrations answer 404 before the body is read; a bad signature is 401.
 */

export const chatAgentPublicRouter = new Hono<AppEnv>();


// ── Helpers ────────────────────────────────────────────────────────────────

export function encryptionKeyOf(c: Context<AppEnv>): string | undefined {
  const fromEnv = (c.env as unknown as Record<string, unknown> | undefined)?.['ENCRYPTION_KEY'];
  if (typeof fromEnv === 'string' && fromEnv) return fromEnv;
  const fromProcess = typeof process !== 'undefined' ? process.env?.['ENCRYPTION_KEY'] : undefined;
  return fromProcess || undefined;
}

export const errorBody = (code: string, message?: string) => ({ errors: [{ code, ...(message ? { message } : {}) }] });

/**
 * Background work after the response (Slack wants an ack within 3 s). Kept in
 * a set so tests — and graceful shutdown — can wait for it.
 */
const inflight = new Set<Promise<unknown>>();
export async function settleChatAgentTasks(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}
function background(c: Context<AppEnv>, label: string, work: () => Promise<unknown>): void {
  const task: Promise<unknown> = work()
    .catch((err: unknown) => console.warn(`[chat-agent] ${label} failed`, err instanceof Error ? err.message : String(err)))
    .finally(() => inflight.delete(task));
  inflight.add(task);
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // Node: the promise keeps running on its own.
  }
}

interface Verified {
  db: Database;
  siteId: string;
  service: ChatIntegrationService;
  row: ChatIntegrationRow;
  rawBody: string;
}

/** Loads the integration named in the path and verifies the request signature. */
async function verified(c: Context<AppEnv>, provider: ChatProvider): Promise<Verified | Response> {
  const siteId = c.req.param('siteId');
  const integrationId = c.req.param('integrationId');
  if (!siteId || !integrationId) return c.json(errorBody('NOT_FOUND'), 404);
  const db = scopedDbFor(c, siteId);
  const service = new ChatIntegrationService({ db, siteId, encryptionKey: encryptionKeyOf(c) });
  const row = await service.getRow(integrationId);
  if (!row || row.provider !== provider || !row.enabled) return c.json(errorBody('NOT_FOUND'), 404);

  let secret: string | null;
  try {
    secret = await service.decryptSecret(row, 'signing_secret');
  } catch {
    secret = null;
  }
  if (!secret) return c.json(errorBody('SECRET_UNAVAILABLE'), 500);

  const rawBody = await c.req.text();
  const verdict = provider === 'slack'
    ? await verifySlackSignature({
        secret, rawBody,
        timestamp: c.req.header('x-slack-request-timestamp'),
        signature: c.req.header('x-slack-signature'),
      })
    : await verifyWebhookSignature({
        secret, rawBody,
        timestamp: c.req.header('x-lumibase-timestamp'),
        signature: c.req.header('x-lumibase-signature'),
      });
  if (!verdict.ok) {
    await new AuditLogger({ db, siteId }).write({
      siteId,
      event: 'chat_agent_signature_rejected',
      metadata: { integrationId, provider, reason: verdict.reason },
      requestId: c.get('requestId') ?? null,
    }).catch(() => undefined);
    return c.json(errorBody('INVALID_SIGNATURE'), 401);
  }
  return { db, siteId, service, row, rawBody };
}

type TurnOutcome =
  | { kind: 'unlinked' }
  | { kind: 'empty' }
  | { kind: 'result'; result: DispatchResult };

/** One Copilot turn as the linked user; records the event outcome. */
async function runTurn(
  c: Context<AppEnv>,
  ctx: Verified,
  input: { eventId: string; text: string; externalUserId: string; threadKey: string | null },
): Promise<TurnOutcome> {
  const userId = await ctx.service.resolveLink(ctx.row.id, input.externalUserId);
  if (!userId) {
    await ctx.service.finishEvent(input.eventId, 'unlinked');
    return { kind: 'unlinked' };
  }
  const text = input.text.trim().slice(0, 2000);
  if (!text) {
    await ctx.service.finishEvent(input.eventId, 'done');
    return { kind: 'empty' };
  }
  const conversationId = input.threadKey
    ? await ctx.service.threadConversation(ctx.row.id, input.threadKey, input.externalUserId)
    : null;
  const result = await dispatchAsUser(
    c,
    { db: ctx.db, siteId: ctx.siteId, userId, channel: ctx.row.provider },
    '/chat',
    { message: text, ...(conversationId ? { conversationId } : {}) },
  );
  const nextConversation = typeof result.body.data?.['conversationId'] === 'string' ? result.body.data['conversationId'] : null;
  await ctx.service.finishEvent(input.eventId, result.status === 200 ? 'done' : 'failed', nextConversation);
  return { kind: 'result', result };
}

async function decideAsLinkedUser(
  c: Context<AppEnv>,
  ctx: Verified,
  input: { externalUserId: string; approvalId: string; decision: 'approved' | 'rejected' },
): Promise<{ kind: 'unlinked' } | { kind: 'result'; result: DispatchResult }> {
  const userId = await ctx.service.resolveLink(ctx.row.id, input.externalUserId);
  if (!userId) return { kind: 'unlinked' };
  const result = await dispatchAsUser(
    c,
    { db: ctx.db, siteId: ctx.siteId, userId, channel: ctx.row.provider },
    `/approvals/${encodeURIComponent(input.approvalId)}/decide`,
    { decision: input.decision },
  );
  return { kind: 'result', result };
}

const UNLINKED_TEXT = (who: string) =>
  `${who}, your chat account is not linked to a LumiBase user on this site, so I can't act for you. Ask a site admin to link it.`;
const HELP_TEXT = 'Tell me what to do, for example: draft a post about our spring launch.';

function slackMessageFor(outcome: TurnOutcome, slackUserId: string): SlackMessage {
  const who = `<@${escapeMrkdwn(slackUserId)}>`;
  if (outcome.kind === 'unlinked') return { text: UNLINKED_TEXT(who) };
  if (outcome.kind === 'empty') return { text: HELP_TEXT };
  const { result } = outcome;
  if (result.status !== 200 || !result.body.data) {
    return { text: `Sorry, that failed: ${escapeMrkdwn(result.body.errors?.[0]?.message ?? `HTTP ${result.status}`)}` };
  }
  return copilotReply(result.body.data);
}

// ── Slack ─────────────────────────────────────────────────────────────────

chatAgentPublicRouter.post('/slack/:siteId/:integrationId/events', async (c) => {
  const ctx = await verified(c, 'slack');
  if (ctx instanceof Response) return ctx;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(ctx.rawBody) as Record<string, unknown>;
  } catch {
    return c.json(errorBody('VALIDATION', 'Body must be JSON.'), 400);
  }
  if (payload['type'] === 'url_verification' && typeof payload['challenge'] === 'string') {
    return c.json({ challenge: payload['challenge'] });
  }
  if (payload['type'] !== 'event_callback') return c.body(null, 200);
  if (payload['team_id'] !== ctx.row.externalId) return c.json(errorBody('WRONG_WORKSPACE'), 403);

  const event = (payload['event'] ?? {}) as Record<string, unknown>;
  const eventKey = payload['event_id'];
  const user = event['user'];
  const channel = event['channel'];
  // Only mentions by people; the bot's own posts never start a turn.
  if (event['type'] !== 'app_mention' || event['bot_id'] || typeof eventKey !== 'string'
    || typeof user !== 'string' || typeof channel !== 'string') {
    return c.body(null, 200);
  }
  const threadTs = typeof event['thread_ts'] === 'string' ? event['thread_ts'] : typeof event['ts'] === 'string' ? event['ts'] : undefined;
  const threadKey = `${channel}:${threadTs ?? 'root'}`;
  const eventId = await ctx.service.recordEvent({ integrationId: ctx.row.id, eventKey, threadKey, externalUserId: user });
  if (!eventId) return c.json({ ok: true, duplicate: true });

  background(c, 'slack mention', async () => {
    const outcome = await runTurn(c, ctx, {
      eventId, threadKey, externalUserId: user,
      text: stripMentions(typeof event['text'] === 'string' ? event['text'] : ''),
    });
    const botToken = await ctx.service.decryptSecret(ctx.row, 'bot_token').catch(() => null);
    if (!botToken) {
      console.warn('[chat-agent] slack integration has no bot token; reply not posted', ctx.row.id);
      return;
    }
    await postMessage(botToken, { channel, ...(threadTs ? { threadTs } : {}), message: slackMessageFor(outcome, user) });
  });
  return c.json({ ok: true });
});

chatAgentPublicRouter.post('/slack/:siteId/:integrationId/commands', async (c) => {
  const ctx = await verified(c, 'slack');
  if (ctx instanceof Response) return ctx;
  const form = new URLSearchParams(ctx.rawBody);
  if (form.get('team_id') !== ctx.row.externalId) return c.json(errorBody('WRONG_WORKSPACE'), 403);
  const user = form.get('user_id');
  const channel = form.get('channel_id');
  const responseUrl = form.get('response_url');
  const trigger = form.get('trigger_id');
  if (!user || !channel || !responseUrl || !trigger) return c.json(errorBody('VALIDATION', 'Missing slash-command fields.'), 400);

  const eventId = await ctx.service.recordEvent({
    integrationId: ctx.row.id, eventKey: `command:${trigger}`, threadKey: `${channel}:command`, externalUserId: user,
  });
  if (!eventId) return c.body(null, 200);
  background(c, 'slack command', async () => {
    const outcome = await runTurn(c, ctx, { eventId, threadKey: `${channel}:command`, externalUserId: user, text: form.get('text') ?? '' });
    await respond(responseUrl, { ...slackMessageFor(outcome, user), ephemeral: outcome.kind !== 'result' });
  });
  return c.json({ response_type: 'ephemeral', text: 'Working on it…' });
});

chatAgentPublicRouter.post('/slack/:siteId/:integrationId/interactions', async (c) => {
  const ctx = await verified(c, 'slack');
  if (ctx instanceof Response) return ctx;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new URLSearchParams(ctx.rawBody).get('payload') ?? '') as Record<string, unknown>;
  } catch {
    return c.json(errorBody('VALIDATION', 'Missing interaction payload.'), 400);
  }
  const team = (payload['team'] ?? {}) as Record<string, unknown>;
  if (team['id'] !== ctx.row.externalId) return c.json(errorBody('WRONG_WORKSPACE'), 403);
  const action = (Array.isArray(payload['actions']) ? payload['actions'][0] : null) as Record<string, unknown> | null;
  const user = ((payload['user'] ?? {}) as Record<string, unknown>)['id'];
  const responseUrl = payload['response_url'];
  if (payload['type'] !== 'block_actions' || !action || typeof user !== 'string' || typeof responseUrl !== 'string') {
    return c.body(null, 200);
  }
  const actionId = action['action_id'];
  const approvalId = action['value'];
  if ((actionId !== APPROVE_ACTION && actionId !== REJECT_ACTION) || typeof approvalId !== 'string') return c.body(null, 200);
  const eventKey = `action:${typeof payload['trigger_id'] === 'string' ? payload['trigger_id'] : `${approvalId}:${String(action['action_ts'] ?? '')}`}`;
  const eventId = await ctx.service.recordEvent({ integrationId: ctx.row.id, eventKey, externalUserId: user });
  if (!eventId) return c.body(null, 200);

  const decision = actionId === APPROVE_ACTION ? 'approved' : 'rejected';
  background(c, 'slack approval', async () => {
    const who = `<@${escapeMrkdwn(user)}>`;
    const outcome = await decideAsLinkedUser(c, ctx, { externalUserId: user, approvalId, decision });
    if (outcome.kind === 'unlinked') {
      await ctx.service.finishEvent(eventId, 'unlinked');
      await respond(responseUrl, { text: UNLINKED_TEXT(who), ephemeral: true });
      return;
    }
    const { result } = outcome;
    if (result.status !== 200) {
      await ctx.service.finishEvent(eventId, 'failed');
      const reason = escapeMrkdwn(result.body.errors?.[0]?.message ?? `HTTP ${result.status}`);
      await respond(responseUrl, { text: `${who}, you can't decide this approval: ${reason}`, ephemeral: true });
      return;
    }
    await ctx.service.finishEvent(eventId, 'done');
    const status = typeof result.body.data?.['status'] === 'string' ? ` (${escapeMrkdwn(result.body.data['status'])})` : '';
    await respond(responseUrl, {
      text: decision === 'approved' ? `Approved by ${who}${status}.` : `Rejected by ${who}.`,
      replaceOriginal: true,
    });
  });
  return c.body(null, 200);
});

// ── Generic webhook (Teams / Discord / custom bots) ───────────────────────

const webhookMessageSchema = z.object({
  /** The chat tool's own user id; must be linked to a LumiBase user. */
  userId: z.string().min(1).max(128),
  text: z.string().min(1).max(2000),
  /** Groups messages into one Copilot conversation per (thread, user). */
  threadId: z.string().min(1).max(200).optional(),
}).strict();

const webhookDecisionSchema = z.object({
  userId: z.string().min(1).max(128),
  decision: z.enum(['approved', 'rejected']),
}).strict();

function parseJson<T>(raw: string, schema: z.ZodType<T>): { ok: true; data: T } | { ok: false; issues: z.ZodIssue[] } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, issues: [{ code: 'custom', message: 'Body must be JSON.', path: [] } as z.ZodIssue] };
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, issues: parsed.error.issues };
}

export const validation = (issues: z.ZodIssue[]) => ({
  errors: issues.map((issue) => ({ code: 'VALIDATION', message: issue.message, path: issue.path.map(String) })),
});

chatAgentPublicRouter.post('/webhook/:siteId/:integrationId/messages', async (c) => {
  const ctx = await verified(c, 'webhook');
  if (ctx instanceof Response) return ctx;
  const parsed = parseJson(ctx.rawBody, webhookMessageSchema);
  if (!parsed.ok) return c.json(validation(parsed.issues), 400);
  const delivery = c.req.header('x-lumibase-delivery');
  if (delivery !== undefined && (delivery.length === 0 || delivery.length > 128)) {
    return c.json(errorBody('VALIDATION', 'X-Lumibase-Delivery must be 1-128 characters.'), 400);
  }
  const threadKey = parsed.data.threadId ?? null;
  const eventId = await ctx.service.recordEvent({
    integrationId: ctx.row.id,
    eventKey: delivery ? `delivery:${delivery}` : `message:${nanoid()}`,
    threadKey,
    externalUserId: parsed.data.userId,
  });
  if (!eventId) return c.json(errorBody('DUPLICATE_DELIVERY', 'This delivery was already processed.'), 409);
  const outcome = await runTurn(c, ctx, { eventId, threadKey, externalUserId: parsed.data.userId, text: parsed.data.text });
  if (outcome.kind === 'unlinked') return c.json(errorBody('USER_NOT_LINKED', 'This chat user is not linked to a LumiBase user of the site.'), 403);
  if (outcome.kind === 'empty') return c.json(errorBody('VALIDATION', 'text is empty.'), 400);
  const { result } = outcome;
  return c.json(
    result.status === 200 && result.body.data
      ? { data: { ...result.body.data, ...(threadKey ? { threadId: threadKey } : {}) } }
      : result.body,
    result.status as 200,
  );
});

chatAgentPublicRouter.post('/webhook/:siteId/:integrationId/approvals/:approvalId/decide', async (c) => {
  const ctx = await verified(c, 'webhook');
  if (ctx instanceof Response) return ctx;
  const parsed = parseJson(ctx.rawBody, webhookDecisionSchema);
  if (!parsed.ok) return c.json(validation(parsed.issues), 400);
  const outcome = await decideAsLinkedUser(c, ctx, {
    externalUserId: parsed.data.userId,
    approvalId: c.req.param('approvalId'),
    decision: parsed.data.decision,
  });
  if (outcome.kind === 'unlinked') return c.json(errorBody('USER_NOT_LINKED', 'This chat user is not linked to a LumiBase user of the site.'), 403);
  return c.json(outcome.result.body, outcome.result.status as 200);
});
