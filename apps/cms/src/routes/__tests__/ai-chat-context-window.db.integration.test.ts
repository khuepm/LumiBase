import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  agentApprovals,
  aiApprovals,
  aiConversations,
  aiMessages,
  collections,
  fields,
  flowRuns,
  items,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import type { AppEnv, AuthPrincipal } from '../../env';
import { aiRouter } from '../ai';
import { executeAiChatRun } from '../../services/ai-chat-run-worker';
import { createPendingRun } from '../../services/flow-run-service';
import { COPILOT_HISTORY_MAX_MESSAGES } from '../../services/copilot-history';

/**
 * Copilot context window and structured-output safety (#582).
 *
 * ## What was wrong (measured at 5a92d6ea, before the fix)
 *
 * `POST /ai/chat` and its queued worker loaded history with
 * `ORDER BY created_at ASC LIMIT 20`: the OLDEST twenty messages. From the 21st
 * message of a conversation on, the turn the user had just sent was not in the
 * request; the model answered the first ten turns again, and any tool call it
 * returned ran with the user's rights.
 *
 * ## Evidence class
 *
 * REAL PostgreSQL, the real router and worker, and the real `OpenAIProvider`
 * with `fetch` stubbed: every assertion about the request reads the JSON body
 * that would have gone upstream. No live model is called; the "model answer" is
 * a fixed response, so nothing here is model-sensitive.
 */
const SITE = 'site_582_ctx';
const OTHER_SITE = 'site_582_other';
const ADMIN = 'usr_582_admin';
const ADMIN_ROLE = 'role_582_admin';
const ENV = { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-582-canary-not-a-key' };

interface SentBody {
  messages: Array<{ role: string; content: string }>;
  tools?: unknown[];
  max_tokens?: number;
}

describe.skipIf(!hasDbIntegrationUrl)('#582 Copilot context window — DB integration', () => {
  let db: Database;
  let conversationId: string;
  let collectionId: string;
  let otherCollectionId: string;
  let sent: SentBody[];
  let answer: () => unknown;

  beforeAll(async () => {
    db = await connectDbIntegration('ai-chat-context-window');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, OTHER_SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(sites).where(eq(sites.id, OTHER_SITE));
    await db.delete(users).where(eq(users.id, ADMIN));
    await db.insert(sites).values([
      { id: SITE, name: '582 context' },
      { id: OTHER_SITE, name: '582 other' },
    ]);
    await db.insert(users).values({ id: ADMIN, email: 'audit-582-admin@example.dev' });
    await db.insert(roles).values({
      id: ADMIN_ROLE,
      siteId: SITE,
      name: '582 Administrator',
      adminAccess: true,
      appAccess: true,
    });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE });
    const [collection] = await db.insert(collections).values({ siteId: SITE, name: 'posts', label: 'Posts' }).returning();
    collectionId = collection!.id;
    const [other] = await db.insert(collections).values({ siteId: OTHER_SITE, name: 'posts', label: 'Posts' }).returning();
    otherCollectionId = other!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId, name: 'title', type: 'string', interface: 'input' },
      { siteId: OTHER_SITE, collectionId: otherCollectionId, name: 'title', type: 'string', interface: 'input' },
    ]);
    const [conv] = await db
      .insert(aiConversations)
      .values({ siteId: SITE, userId: ADMIN, title: '582 long conversation' })
      .returning();
    conversationId = conv!.id;

    sent = [];
    answer = () => ({ choices: [{ message: { content: 'ok' } }] });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as SentBody);
      return new Response(JSON.stringify(answer()), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** `turns` user/assistant pairs, all in the past, strictly increasing. */
  async function seedHistory(turns: number) {
    const start = Date.now() - 3_600_000;
    const rows = [];
    for (let i = 1; i <= turns; i += 1) {
      rows.push({ conversationId, role: 'user', content: `old user turn ${i}`, createdAt: new Date(start + i * 2_000) });
      rows.push({ conversationId, role: 'assistant', content: `old assistant turn ${i}`, createdAt: new Date(start + i * 2_000 + 1_000) });
    }
    await db.insert(aiMessages).values(rows);
  }

  function app() {
    const auth = { userId: ADMIN, email: 'audit-582-admin@example.dev', roles: [ADMIN_ROLE], raw: {} } as unknown as AuthPrincipal;
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', SITE);
      c.set('auth', auth);
      c.set('runtime', {} as never);
      await next();
    });
    hono.route('/ai', aiRouter);
    return hono;
  }

  function chat(message: string) {
    return app().request('/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, message }),
    }, ENV);
  }

  function assertWindow(body: SentBody, latest: string) {
    const [system, ...history] = body.messages;
    // The Copilot instructions are sent apart from the history and never cut.
    expect(system!.role).toBe('system');
    expect(system!.content).toContain('LumiBase AI Copilot');
    expect(history.length).toBeLessThanOrEqual(COPILOT_HISTORY_MAX_MESSAGES);
    // The turn the user just sent is the last message the model sees.
    expect(history.at(-1)).toEqual({ role: 'user', content: latest });
    expect(history[0]!.role).toBe('user');
    expect(history.map((m) => m.content)).not.toContain('old user turn 1');
    // Output reserve and tool catalogue unchanged.
    expect(body.max_tokens).toBe(1024);
    expect(Array.isArray(body.tools) && body.tools.length > 0).toBe(true);
  }

  // ── Context window ───────────────────────────────────────────────────────

  it('a short conversation sends every message, oldest first', async () => {
    await seedHistory(2);
    const res = await chat('latest short');
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.messages.slice(1).map((m) => m.content)).toEqual([
      'old user turn 1',
      'old assistant turn 1',
      'old user turn 2',
      'old assistant turn 2',
      'latest short',
    ]);
  });

  it('after 24 messages the newest window is sent and ends with the new turn (sync route)', async () => {
    await seedHistory(12);
    const res = await chat('LATEST-582 sync');
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    assertWindow(sent[0]!, 'LATEST-582 sync');
    // 25 stored messages → newest 20 is assistant 3 … user latest; the leading
    // assistant message is dropped so the window opens on a user turn.
    expect(sent[0]!.messages[1]!.content).toBe('old user turn 4');
    expect(sent[0]!.messages).toHaveLength(1 + 19);
  });

  it('the queued worker sends the same window', async () => {
    await seedHistory(12);
    await db.insert(aiMessages).values({ conversationId, role: 'user', content: 'LATEST-582 async' });
    const run = await createPendingRun(db, { siteId: SITE, runType: 'ai_chat', input: { conversationId } });
    await executeAiChatRun(db, {
      kind: 'ai_chat',
      siteId: SITE,
      runId: run.id,
      conversationId,
      message: 'LATEST-582 async',
      principal: { type: 'user', siteId: SITE, userId: ADMIN },
      userId: ADMIN,
    }, undefined, ENV);
    expect(sent).toHaveLength(1);
    assertWindow(sent[0]!, 'LATEST-582 async');
    const [row] = await db.select().from(flowRuns).where(eq(flowRuns.id, run.id));
    expect(row!.status).toBe('success');
  });

  // ── Structured output: well-formed but wrong ─────────────────────────────

  function toolAnswer(calls: Array<{ name: string; arguments: string }>) {
    answer = () => ({
      choices: [{ message: { content: null, tool_calls: calls.map((fn) => ({ function: fn })) } }],
    });
  }

  async function seedItem(siteId: string, collection: string, title: string) {
    const [row] = await db.insert(items).values({ siteId, collectionId: collection, status: 'draft', data: { title } }).returning();
    return row!.id;
  }

  async function itemTitle(id: string) {
    const [row] = await db.select().from(items).where(eq(items.id, id));
    return (row!.data as Record<string, unknown>)['title'];
  }

  it('a well-formed update that names another site\'s item id writes nothing', async () => {
    const foreign = await seedItem(OTHER_SITE, otherCollectionId, 'other site title');
    toolAnswer([{ name: 'updateItem', arguments: JSON.stringify({ collection: 'posts', id: foreign, data: { title: 'hijacked' } }) }]);
    const res = await chat('rename that post');
    const body = (await res.json()) as { data?: { status?: string; message?: string } };
    expect(body.data?.status).not.toBe('executed');
    expect(body.data?.message ?? '').toMatch(/not found/i);
    expect(await itemTitle(foreign)).toBe('other site title');
  });

  it('an out-of-enum status is refused as VALIDATION before any write', async () => {
    const own = await seedItem(SITE, collectionId, 'v1');
    toolAnswer([{ name: 'updateItem', arguments: JSON.stringify({ collection: 'posts', id: own, data: { title: 'v2' }, status: 'live' }) }]);
    const res = await chat('publish it');
    const body = (await res.json()) as { data?: { status?: string; code?: string } };
    expect(body.data?.status).toBe('denied');
    expect(body.data?.code).toBe('VALIDATION');
    expect(await itemTitle(own)).toBe('v1');
  });

  it('of two contradictory tool calls only the first runs; the second neither runs nor parks', async () => {
    const own = await seedItem(SITE, collectionId, 'v1');
    toolAnswer([
      { name: 'updateItem', arguments: JSON.stringify({ collection: 'posts', id: own, data: { title: 'v2' } }) },
      { name: 'deleteItem', arguments: JSON.stringify({ collection: 'posts', id: own }) },
    ]);
    const res = await chat('rename it and delete it');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { status?: string } };
    // The first call really ran, so the principal is able to write here.
    expect(body.data?.status).toBe('executed');
    expect(await itemTitle(own)).toBe('v2');
    const [row] = await db.select().from(items).where(eq(items.id, own));
    expect(row).toBeDefined();
    expect(row!.deletedAt ?? null).toBeNull();
    expect(await db.select().from(aiApprovals).where(eq(aiApprovals.siteId, SITE))).toHaveLength(0);
    expect(await db.select().from(agentApprovals).where(eq(agentApprovals.siteId, SITE))).toHaveLength(0);
  });

  it('malformed tool arguments fail once, with no retry, no write and no assistant turn', async () => {
    const own = await seedItem(SITE, collectionId, 'v1');
    toolAnswer([{ name: 'updateItem', arguments: '{"collection":"posts","id":"' }]);
    const res = await chat('rename it');
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(1);
    expect(await itemTitle(own)).toBe('v1');
    const assistant = await db
      .select()
      .from(aiMessages)
      .where(and(eq(aiMessages.conversationId, conversationId), eq(aiMessages.role, 'assistant')));
    expect(assistant).toHaveLength(0);
  });
});
