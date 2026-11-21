import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  aiApprovals,
  chatEvents,
  chatIntegrations,
  collections,
  fields,
  items,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import type { AppEnv, AuthPrincipal } from '../../../env';
import { chatAgentPublicRouter, settleChatAgentTasks } from '../routes';
import { chatAgentRouter } from '../admin-routes';
import { signSlackRequest, signWebhookRequest } from '../signatures';

/**
 * Content Agent from chat (#711) — REAL PostgreSQL, the real routers, the real
 * Copilot route behind them. The model provider is the real `OpenAIProvider`
 * with `fetch` stubbed; Slack's Web API and response URLs are the same stub.
 * Nothing leaves the process and no model is called.
 *
 * Acceptance pinned here:
 *  - "@lumibase draft a post about X" creates a DRAFT item, as the linked user,
 *    and the reply lands in the thread;
 *  - a dangerous action parks, the reply carries Approve / Reject, and the
 *    buttons decide it — as the CLICKING user's linked account, so a linked
 *    non-admin cannot approve and a linked admin can;
 *  - signed-request verification; per-site install (another site's
 *    integration id, a disabled one, a forged or stale signature: refused).
 */

const SITE = 'site_711_a';
const OTHER = 'site_711_b';
const ADMIN = 'usr_711_admin';
const EDITOR = 'usr_711_editor';
const OUTSIDER = 'usr_711_outsider';
const ADMIN_ROLE = 'role_711_admin';
const EDITOR_ROLE = 'role_711_editor';
const TEAM = 'T0711TEAM';
const SLACK_SECRET = 'slack-signing-secret-711-0000000000';
const ENV = {
  LLM_PROVIDER: 'openai',
  OPENAI_API_KEY: 'sk-test-711-not-a-key',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

interface Sent { url: string; body: Record<string, unknown> }

describe.skipIf(!hasDbIntegrationUrl)('#711 chat agent — DB integration', () => {
  let db: Database;
  let sent: Sent[];
  let modelAnswers: unknown[];
  let slackId: string;
  let webhookId: string;
  let webhookSecret: string;

  beforeAll(async () => {
    db = await connectDbIntegration('chat-agent');
  });

  const cleanup = async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER})`);
    await db.delete(users).where(sql`${users.id} IN (${ADMIN}, ${EDITOR}, ${OUTSIDER})`);
  };
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });

  function app(asUser = ADMIN, siteId = SITE) {
    const auth = { type: 'user', userId: asUser, email: `${asUser}@example.dev`, roles: [], raw: {} } as unknown as AuthPrincipal;
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', db);
      c.set('runtime', {} as never);
      if (c.req.path.startsWith('/api/v1/chat-agent/integrations')) {
        c.set('siteId', siteId);
        c.set('auth', auth);
      }
      await next();
    });
    hono.route('/api/v1/chat-agent', chatAgentPublicRouter);
    hono.route('/api/v1/chat-agent', chatAgentRouter);
    return hono;
  }

  async function admin(method: string, path: string, body?: unknown, asUser = ADMIN, siteId = SITE) {
    const res = await app(asUser, siteId).request(`/api/v1/chat-agent${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, ENV);
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ code: string }> } };
  }

  async function slack(kind: 'events' | 'commands' | 'interactions', body: string, opts: { secret?: string; ts?: number; integrationId?: string; siteId?: string } = {}) {
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    const contentType = kind === 'events' ? 'application/json' : 'application/x-www-form-urlencoded';
    const res = await app().request(`/api/v1/chat-agent/slack/${opts.siteId ?? SITE}/${opts.integrationId ?? slackId}/${kind}`, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await signSlackRequest(opts.secret ?? SLACK_SECRET, body, ts),
      },
      body,
    }, ENV);
    const text = await res.text();
    await settleChatAgentTasks();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  async function webhook(path: string, payload: unknown, headers: Record<string, string> = {}) {
    const raw = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    const res = await app().request(`/api/v1/chat-agent/webhook/${SITE}/${webhookId}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-lumibase-timestamp': String(ts),
        'x-lumibase-signature': await signWebhookRequest(webhookSecret, raw, ts),
        ...headers,
      },
      body: raw,
    }, ENV);
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ code: string }> } };
  }

  const mention = (text: string, user: string, id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
    type: 'event_callback',
    team_id: TEAM,
    event_id: id,
    event: { type: 'app_mention', user, text, channel: 'C0711', ts: '1795000000.000100', ...extra },
  });

  const toolCall = (name: string, args: Record<string, unknown>) => ({
    choices: [{ message: { content: null, tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
  });

  const posted = () => sent.filter((s) => s.url === 'https://slack.com/api/chat.postMessage').map((s) => s.body);
  const responded = () => sent.filter((s) => s.url.startsWith('https://hooks.slack.com/')).map((s) => s.body);
  // Match on the parsed host, not a substring of the URL (CodeQL js/incomplete-url-substring-sanitization).
  const isModelCall = (url: string) => new URL(url).hostname === 'api.openai.com';
  const modelCalls = () => sent.filter((s) => isModelCall(s.url));

  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE, name: '711 A' },
      { organizationId: org, id: OTHER, name: '711 B' },
    ]);
    await db.insert(users).values([
      { id: ADMIN, email: 'admin-711@example.dev' },
      { id: EDITOR, email: 'editor-711@example.dev' },
      { id: OUTSIDER, email: 'outsider-711@example.dev' },
    ]);
    await db.insert(roles).values([
      { id: ADMIN_ROLE, siteId: SITE, name: '711 Admin', adminAccess: true, appAccess: true },
      { id: EDITOR_ROLE, siteId: SITE, name: '711 Editor', adminAccess: false, appAccess: true },
    ]);
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE },
      { userId: EDITOR, siteId: SITE, roleId: EDITOR_ROLE },
    ]);
    const [posts] = await db.insert(collections).values({ siteId: SITE, name: 'posts', label: 'Posts' }).returning();
    await db.insert(fields).values({ siteId: SITE, collectionId: posts!.id, name: 'title', type: 'string', interface: 'input' });

    sent = [];
    modelAnswers = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push({ url, body });
      if (isModelCall(url)) {
        const answer = modelAnswers.shift() ?? { choices: [{ message: { content: 'ok' } }] };
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const installedSlack = await admin('POST', '/integrations', {
      provider: 'slack', name: 'Acme Slack', externalId: TEAM, signingSecret: SLACK_SECRET, botToken: 'xoxb-711-test-token-abc',
    });
    expect(installedSlack.status).toBe(201);
    slackId = installedSlack.body.data!['id'] as string;
    const installedHook = await admin('POST', '/integrations', { provider: 'webhook', name: 'Teams bridge' });
    webhookId = installedHook.body.data!['id'] as string;
    webhookSecret = installedHook.body.data!['signingSecret'] as string;
    expect(webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    for (const [external, user] of [['U0ADMIN', ADMIN], ['U0EDITOR', EDITOR]] as const) {
      expect((await admin('PUT', `/integrations/${slackId}/links/${external}`, { userId: user })).status).toBe(200);
    }
    expect((await admin('PUT', `/integrations/${webhookId}/links/teams-admin`, { userId: ADMIN })).status).toBe(200);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Install ──────────────────────────────────────────────────────────────

  it('stores secrets encrypted, never returns them, and shows the webhook secret only once', async () => {
    const [row] = await db.select().from(chatIntegrations).where(eq(chatIntegrations.id, slackId));
    expect(row!.signingSecretEnc).not.toContain(SLACK_SECRET);
    expect(row!.botTokenEnc).not.toContain('xoxb-');
    const listed = await admin('GET', '/integrations');
    const text = JSON.stringify(listed.body);
    expect(text).not.toContain(SLACK_SECRET);
    expect(text).not.toContain(webhookSecret);
    expect(text).not.toContain('Enc');
    const slackView = (listed.body.data as unknown as Array<Record<string, unknown>>).find((r) => r['id'] === slackId)!;
    expect(slackView).toMatchObject({ provider: 'slack', externalId: TEAM, hasBotToken: true, enabled: true });
    expect(slackView['endpoints']).toMatchObject({ events: expect.stringContaining(`/api/v1/chat-agent/slack/${SITE}/${slackId}/events`) });
  });

  it('only site admins manage integrations, and only site members can be linked', async () => {
    expect((await admin('GET', '/integrations', undefined, EDITOR)).status).toBe(403);
    expect((await admin('POST', '/integrations', { provider: 'webhook', name: 'x' }, EDITOR)).status).toBe(403);
    const outsider = await admin('PUT', `/integrations/${slackId}/links/U0OUT`, { userId: OUTSIDER });
    expect(outsider).toMatchObject({ status: 400, body: { errors: [{ code: 'VALIDATION' }] } });
    expect((await admin('POST', '/integrations', { provider: 'slack', name: 'no secret', externalId: TEAM })).status).toBe(400);
    // Another site's admin cannot see or touch this site's integration.
    expect((await admin('PATCH', `/integrations/${slackId}`, { enabled: false }, ADMIN, OTHER)).status).toBe(403);
  });

  // ── Signed requests ─────────────────────────────────────────────────────

  it('answers the Slack URL challenge only to a correctly signed request', async () => {
    const challenge = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    expect(await slack('events', challenge)).toMatchObject({ status: 200, body: { challenge: 'abc123' } });
    expect((await slack('events', challenge, { secret: 'wrong-secret-000000000000' })).status).toBe(401);
    expect((await slack('events', challenge, { ts: Math.floor(Date.now() / 1000) - 600 })).status).toBe(401);
  });

  it('per-site install: another site, another provider or a disabled integration is not found', async () => {
    const challenge = JSON.stringify({ type: 'url_verification', challenge: 'x' });
    expect((await slack('events', challenge, { siteId: OTHER })).status).toBe(404);
    expect((await slack('events', challenge, { integrationId: webhookId })).status).toBe(404);
    expect((await admin('PATCH', `/integrations/${slackId}`, { enabled: false })).status).toBe(200);
    expect((await slack('events', challenge)).status).toBe(404);
  });

  it('refuses an event from another Slack workspace', async () => {
    const body = mention('<@U0BOT> hi', 'U0ADMIN', 'Ev-team').replace(TEAM, 'T0EVIL');
    expect((await slack('events', body)).status).toBe(403);
    expect(modelCalls()).toHaveLength(0);
  });

  // ── Acceptance ──────────────────────────────────────────────────────────

  it('"@lumibase draft a post about X" creates a draft as the linked user and replies in the thread', async () => {
    modelAnswers.push(toolCall('createItem', { collection: 'posts', data: { title: 'Spring launch' }, status: 'draft' }));
    const res = await slack('events', mention('<@U0BOT> draft a post about our spring launch', 'U0ADMIN', 'Ev-draft'));
    expect(res.status).toBe(200);

    // The model saw the text without the bot mention.
    const userTurn = (modelCalls()[0]!.body['messages'] as Array<{ role: string; content: string }>).at(-1)!;
    expect(userTurn).toEqual({ role: 'user', content: 'draft a post about our spring launch' });

    const created = await db.select().from(items).where(eq(items.siteId, SITE));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: 'draft', data: { title: 'Spring launch' } });

    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({ channel: 'C0711', thread_ts: '1795000000.000100' });

    // Slack retries the same event: nothing runs twice.
    await slack('events', mention('<@U0BOT> draft a post about our spring launch', 'U0ADMIN', 'Ev-draft'));
    expect(await db.select().from(items).where(eq(items.siteId, SITE))).toHaveLength(1);
    expect(modelCalls()).toHaveLength(1);
  });

  it('a dangerous action parks; Approve in Slack decides it as the clicking user', async () => {
    modelAnswers.push(toolCall('createCollection', { name: 'events' }));
    await slack('events', mention('<@U0BOT> add an events collection', 'U0EDITOR', 'Ev-park'));
    // The editor has no schema rights: the harness refuses, nothing parks.
    expect(await db.select().from(aiApprovals).where(eq(aiApprovals.siteId, SITE))).toHaveLength(0);

    modelAnswers.push(toolCall('createCollection', { name: 'events' }));
    await slack('events', mention('<@U0BOT> add an events collection', 'U0ADMIN', 'Ev-park-2'));
    const [approval] = await db.select().from(aiApprovals).where(and(eq(aiApprovals.siteId, SITE), eq(aiApprovals.status, 'pending')));
    expect(approval).toBeDefined();
    const reply = posted().at(-1)! as { blocks: Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }> };
    const buttons = reply.blocks.find((b) => b.type === 'actions')!.elements!;
    expect(buttons.map((b) => [b.action_id, b.value])).toEqual([
      ['lumibase_approve', approval!.id],
      ['lumibase_reject', approval!.id],
    ]);

    const click = (user: string, trigger: string) => `payload=${encodeURIComponent(JSON.stringify({
      type: 'block_actions',
      team: { id: TEAM },
      user: { id: user },
      trigger_id: trigger,
      response_url: 'https://hooks.slack.com/actions/T0711/1/abc',
      actions: [{ action_id: 'lumibase_approve', value: approval!.id, action_ts: '1' }],
    }))}`;

    // A linked non-admin cannot approve: told so privately, nothing runs.
    await slack('interactions', click('U0EDITOR', 'tr-1'));
    expect(responded().at(-1)).toMatchObject({ response_type: 'ephemeral', replace_original: false });
    expect(String(responded().at(-1)!['text'])).toContain("can't decide");
    expect(await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'events')))).toHaveLength(0);

    // An unlinked Slack user cannot either.
    await slack('interactions', click('U0STRANGER', 'tr-2'));
    expect(String(responded().at(-1)!['text'])).toContain('not linked');

    // The linked admin approves: executed, and the buttons are replaced.
    await slack('interactions', click('U0ADMIN', 'tr-3'));
    expect(responded().at(-1)).toMatchObject({ replace_original: true });
    expect(String(responded().at(-1)!['text'])).toContain('Approved by <@U0ADMIN>');
    expect(await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'events')))).toHaveLength(1);
    const [decided] = await db.select().from(aiApprovals).where(eq(aiApprovals.id, approval!.id));
    expect(decided!.status).not.toBe('pending');
  });

  it('an unlinked Slack user gets a link hint and no model call', async () => {
    await slack('events', mention('<@U0BOT> delete everything', 'U0STRANGER', 'Ev-unlinked'));
    expect(modelCalls()).toHaveLength(0);
    expect(String(posted()[0]!['text'])).toContain('not linked');
    const [event] = await db.select().from(chatEvents).where(eq(chatEvents.eventKey, 'Ev-unlinked'));
    expect(event!.status).toBe('unlinked');
  });

  it('a slash command acks at once and answers through the response URL', async () => {
    modelAnswers.push({ choices: [{ message: { content: 'There are 0 posts.' } }] });
    const body = new URLSearchParams({
      team_id: TEAM, user_id: 'U0ADMIN', channel_id: 'C0711', text: 'how many posts?',
      response_url: 'https://hooks.slack.com/commands/T0711/1/xyz', trigger_id: 'trig-cmd-1',
    }).toString();
    const res = await slack('commands', body);
    expect(res).toMatchObject({ status: 200, body: { response_type: 'ephemeral' } });
    expect(responded().at(-1)).toMatchObject({ text: 'There are 0 posts.', response_type: 'in_channel' });

    // A response URL outside hooks.slack.com is never called.
    const before = sent.length;
    modelAnswers.push({ choices: [{ message: { content: 'x' } }] });
    await slack('commands', new URLSearchParams({
      team_id: TEAM, user_id: 'U0ADMIN', channel_id: 'C0711', text: 'hi',
      response_url: 'https://evil.example/hook', trigger_id: 'trig-cmd-2',
    }).toString());
    expect(sent.slice(before).some((s) => s.url.includes('evil.example'))).toBe(false);
  });

  // ── Generic webhook ─────────────────────────────────────────────────────

  it('generic webhook: a signed message runs synchronously; a thread keeps its conversation', async () => {
    modelAnswers.push({ choices: [{ message: { content: 'First answer.' } }] });
    const first = await webhook('/messages', { userId: 'teams-admin', text: 'hello', threadId: 'thread-1' }, { 'x-lumibase-delivery': 'd-1' });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ message: 'First answer.', threadId: 'thread-1' });

    modelAnswers.push({ choices: [{ message: { content: 'Second.' } }] });
    const second = await webhook('/messages', { userId: 'teams-admin', text: 'and again', threadId: 'thread-1' });
    expect(second.body.data!['conversationId']).toBe(first.body.data!['conversationId']);
    const history = (modelCalls().at(-1)!.body['messages'] as Array<{ content: string }>).map((m) => m.content);
    expect(history).toContain('hello');

    expect((await webhook('/messages', { userId: 'teams-admin', text: 'hello', threadId: 'thread-1' }, { 'x-lumibase-delivery': 'd-1' })).status).toBe(409);
    expect((await webhook('/messages', { userId: 'nobody', text: 'hi' })).body.errors![0]!.code).toBe('USER_NOT_LINKED');
    expect((await webhook('/messages', { userId: 'teams-admin', text: 'hi', admin: true })).status).toBe(400);
  });

  it('generic webhook: approvals are decided as the linked user', async () => {
    modelAnswers.push(toolCall('createCollection', { name: 'faq' }));
    const parked = await webhook('/messages', { userId: 'teams-admin', text: 'add a faq collection' });
    expect(parked.body.data).toMatchObject({ status: 'pending_approval' });
    const approvalId = parked.body.data!['approvalId'] as string;
    const decided = await webhook(`/approvals/${approvalId}/decide`, { userId: 'teams-admin', decision: 'approved' });
    expect(decided.status).toBe(200);
    expect(await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'faq')))).toHaveLength(1);
    // Replaying the decision is refused by the approval itself.
    expect((await webhook(`/approvals/${approvalId}/decide`, { userId: 'teams-admin', decision: 'approved' })).status).toBe(403);
  });

  it('a forged webhook request is refused before anything is recorded', async () => {
    const raw = JSON.stringify({ userId: 'teams-admin', text: 'hi' });
    const ts = Math.floor(Date.now() / 1000);
    const res = await app().request(`/api/v1/chat-agent/webhook/${SITE}/${webhookId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lumibase-timestamp': String(ts), 'x-lumibase-signature': await signWebhookRequest('not-the-secret', raw, ts) },
      body: raw,
    }, ENV);
    expect(res.status).toBe(401);
    expect(await db.select().from(chatEvents).where(eq(chatEvents.integrationId, webhookId))).toEqual([]);
    expect(modelCalls()).toHaveLength(0);
  });
});
