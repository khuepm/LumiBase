import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { aiConversations, aiMessages, sites, users, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import type { AppEnv, AuthPrincipal } from '../../env';
import { aiRouter } from '../ai';

/**
 * A Copilot conversation belongs to the user who started it (#579).
 *
 * Measured at b12e9385: every conversation route checked only `site_id`. Another
 * member of the same site who knew a conversation id could read its messages,
 * delete it, or append to it through `POST /ai/chat`. Appending is a stored
 * prompt injection: the owner's next turn feeds the appended text to the model
 * as the owner's own history, and a resulting tool call runs with the owner's
 * rights.
 *
 * REAL PostgreSQL; the router is mounted with a fixed principal per request.
 */
const SITE = 'site_579_conv';
const ALICE = 'usr_579_alice';
const MALLORY = 'usr_579_mallory';

describe.skipIf(!hasDbIntegrationUrl)('#579 conversation ownership — DB integration', () => {
  let db: Database;
  let aliceConversation: string;

  beforeAll(async () => {
    db = await connectDbIntegration('ai-conversation-ownership');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(sql`${users.id} IN (${ALICE}, ${MALLORY})`).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(sql`${users.id} IN (${ALICE}, ${MALLORY})`);
    await db.insert(sites).values({ id: SITE, name: '579 conversations' });
    await db.insert(users).values([
      { id: ALICE, email: 'alice-579@example.dev' },
      { id: MALLORY, email: 'mallory-579@example.dev' },
    ]);
    const [conv] = await db
      .insert(aiConversations)
      .values({ siteId: SITE, userId: ALICE, title: 'Alice private' })
      .returning();
    aliceConversation = conv!.id;
    await db.insert(aiMessages).values({
      conversationId: aliceConversation,
      role: 'user',
      content: 'Alice secret plan',
    });
  });

  function app(userId: string | undefined) {
    const auth: AuthPrincipal = { userId, email: `${userId}@example.dev`, roles: [], raw: {} } as AuthPrincipal;
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

  async function aliceMessages() {
    return db.select().from(aiMessages).where(eq(aiMessages.conversationId, aliceConversation));
  }

  it('the owner reads her own messages', async () => {
    const res = await app(ALICE).request(`/ai/conversations/${aliceConversation}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ content: string }> };
    expect(body.data.map((m) => m.content)).toEqual(['Alice secret plan']);
  });

  it('another member of the site gets 404 for her messages', async () => {
    const res = await app(MALLORY).request(`/ai/conversations/${aliceConversation}/messages`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Alice secret plan');
  });

  it('another member cannot delete her conversation', async () => {
    const res = await app(MALLORY).request(`/ai/conversations/${aliceConversation}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const [row] = await db.select().from(aiConversations).where(eq(aiConversations.id, aliceConversation));
    expect(row).toBeDefined();
  });

  it('another member cannot append to her conversation through POST /chat', async () => {
    const res = await app(MALLORY).request('/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: aliceConversation, message: 'hello' }),
    }, { LLM_PROVIDER: 'echo' });
    // The message lands in a NEW conversation owned by the caller.
    const body = (await res.json()) as { data?: { conversationId?: string } };
    expect(body.data?.conversationId).toBeDefined();
    expect(body.data?.conversationId).not.toBe(aliceConversation);
    expect((await aliceMessages()).map((m) => m.content)).toEqual(['Alice secret plan']);
    const [created] = await db
      .select()
      .from(aiConversations)
      .where(eq(aiConversations.id, body.data!.conversationId!));
    expect(created!.userId).toBe(MALLORY);
  });

  it('a caller without a user id does not list user conversations', async () => {
    const res = await app(undefined).request('/ai/conversations');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((c) => c.id)).not.toContain(aliceConversation);
  });
});
