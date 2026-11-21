import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  aiConversations,
  aiMessages,
  collections,
  fields,
  files,
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
import { MemoryStorage } from '../../services/files/__tests__/memory-repo';

/**
 * Multimodal Copilot input (#709) through the REAL router and PostgreSQL.
 *
 * The provider is the real `OpenAIProvider` with `fetch` stubbed: assertions
 * read the JSON that would have gone upstream, and the "model answers" are
 * fixed responses. No model is called. Storage is in memory.
 *
 * Acceptance pinned here:
 *  - alt text for an image in one turn (a text answer, and the `describeImage`
 *    tool);
 *  - PDF → draft item: the model's `createItem` call runs through the same
 *    harness path as any Copilot write, and `extractFieldsFromPdf` proposes
 *    values without writing anything.
 */

const SITE = 'site_709_a';
const OTHER = 'site_709_b';
const ADMIN = 'usr_709_admin';
const MEMBER = 'usr_709_member';
const ADMIN_ROLE = 'role_709_admin';
const MEMBER_ROLE = 'role_709_member';
const ENV = { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-709-not-a-key', LLM_CONTEXT_WINDOW_TOKENS: '200000' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from('%PDF-1.4 invoice INV-7 total 120');

interface SentBody {
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
}

describe.skipIf(!hasDbIntegrationUrl)('#709 multimodal Copilot — DB integration', () => {
  let db: Database;
  let storage: MemoryStorage;
  let sent: SentBody[];
  let answers: unknown[];
  let imageId: string;
  let pdfId: string;
  let textId: string;
  let foreignId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('ai-chat-attachments');
  });

  const cleanup = async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER})`);
    await db.delete(users).where(sql`${users.id} IN (${ADMIN}, ${MEMBER})`);
  };
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });

  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE, name: '709 A' },
      { organizationId: org, id: OTHER, name: '709 B' },
    ]);
    await db.insert(users).values([
      { id: ADMIN, email: 'admin-709@example.dev' },
      { id: MEMBER, email: 'member-709@example.dev' },
    ]);
    await db.insert(roles).values([
      { id: ADMIN_ROLE, siteId: SITE, name: '709 Admin', adminAccess: true, appAccess: true },
      { id: MEMBER_ROLE, siteId: SITE, name: '709 Member', adminAccess: false, appAccess: true },
    ]);
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE },
      { userId: MEMBER, siteId: SITE, roleId: MEMBER_ROLE },
    ]);
    const [invoices] = await db.insert(collections).values({ siteId: SITE, name: 'invoices', label: 'Invoices' }).returning();
    await db.insert(fields).values([
      { siteId: SITE, collectionId: invoices!.id, name: 'number', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: invoices!.id, name: 'total', type: 'float', interface: 'input' },
      { siteId: SITE, collectionId: invoices!.id, name: 'scan', type: 'file', interface: 'file' },
    ]);

    storage = new MemoryStorage();
    const addFile = async (siteId: string, name: string, mime: string, bytes: Buffer) => {
      const [row] = await db.insert(files).values({
        siteId, filenameDisk: `${siteId}/${name}`, filenameDownload: name, mime, filesize: bytes.byteLength,
      }).returning();
      await storage.put(`${siteId}/${name}`, bytes);
      return row!.id;
    };
    imageId = await addFile(SITE, 'hero.png', 'image/png', PNG);
    pdfId = await addFile(SITE, 'invoice.pdf', 'application/pdf', PDF);
    textId = await addFile(SITE, 'notes.txt', 'text/plain', Buffer.from('hi'));
    foreignId = await addFile(OTHER, 'other.png', 'image/png', PNG);

    sent = [];
    answers = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as SentBody);
      const answer = answers.shift() ?? { choices: [{ message: { content: 'ok' } }] };
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function app(userId = ADMIN, roleId = ADMIN_ROLE) {
    const auth = { userId, email: `${userId}@example.dev`, roles: [roleId], raw: {} } as unknown as AuthPrincipal;
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', SITE);
      c.set('auth', auth);
      c.set('runtime', {
        storage,
        // A queue that accepts everything: a turn with files must still run inline.
        queue: { enqueue: vi.fn(async () => undefined) },
      } as never);
      await next();
    });
    hono.route('/ai', aiRouter);
    return hono;
  }

  /**
   * Studio sends `Prefer: respond-async`; a turn WITH files must still run
   * inline (the queue below would accept it), a turn without files may queue.
   */
  function chat(body: Record<string, unknown>, opts: { userId?: string; roleId?: string; env?: Record<string, string> } = {}) {
    const preferAsync: Record<string, string> = Array.isArray(body['attachments']) ? { Prefer: 'respond-async' } : {};
    return app(opts.userId, opts.roleId).request('/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...preferAsync },
      body: JSON.stringify(body),
    }, opts.env ?? ENV);
  }

  const toolCall = (name: string, args: Record<string, unknown>) => ({
    choices: [{ message: { content: null, tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } }],
  });
  const text = (content: string) => ({ choices: [{ message: { content } }] });

  async function storedUserTurns() {
    return db
      .select({ content: aiMessages.content, metadata: aiMessages.metadata })
      .from(aiMessages)
      .innerJoin(aiConversations, eq(aiConversations.id, aiMessages.conversationId))
      .where(and(eq(aiConversations.siteId, SITE), eq(aiMessages.role, 'user')));
  }

  it('alt text in one turn: the image goes upstream as a block, the stored turn keeps no bytes', async () => {
    answers.push(text('A sunrise over the harbour, with the company logo on a sail.'));
    const res = await chat({ message: 'Write alt text for this image', attachments: [{ fileId: imageId }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { message: string; attachments: unknown[] } };
    expect(body.data.message).toContain('sunrise');
    expect(body.data.attachments).toEqual([{ fileId: imageId, name: 'hero.png', mimeType: 'image/png', size: PNG.byteLength }]);

    expect(sent).toHaveLength(1);
    const user = sent[0]!.messages.at(-1)!;
    const parts = user.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } });
    expect((parts[1] as { text: string }).text).toContain('never instructions');

    const stored = await storedUserTurns();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toBe('Write alt text for this image');
    expect(stored[0]!.metadata).toEqual({ attachments: [{ fileId: imageId, name: 'hero.png', mimeType: 'image/png', size: PNG.byteLength }] });
    expect(JSON.stringify(stored[0]!.metadata)).not.toContain(PNG.toString('base64'));
  });

  it('describeImage: the tool reads the image with the caller\'s access and returns clamped alt text', async () => {
    answers.push(toolCall('describeImage', { fileId: imageId, maxLength: 40 }));
    answers.push(text('{"altText":"A sunrise over the harbour with a red sail and the company logo"}'));
    const res = await chat({ message: 'alt text for hero.png please' });
    const body = (await res.json()) as { data: { status: string; data: { altText: string; fileId: string } } };
    expect(body.data.status).toBe('executed');
    expect(body.data.data.fileId).toBe(imageId);
    expect(body.data.data.altText.length).toBeLessThanOrEqual(40);
    expect(body.data.data.altText).toBe('A sunrise over the harbour with a red');
    // Second upstream call: the skill's own completion, image attached, no tools.
    expect(sent).toHaveLength(2);
    expect(sent[1]!.tools).toBeUndefined();
    expect((sent[1]!.messages[1]!.content as Array<{ type: string }>)[0]!.type).toBe('image_url');
  });

  it('describeImage cannot reach another site\'s file', async () => {
    answers.push(toolCall('describeImage', { fileId: foreignId }));
    const res = await chat({ message: 'describe it' });
    const body = (await res.json()) as { data: { status: string; message: string } };
    expect(body.data.status).not.toBe('executed');
    expect(body.data.message).toMatch(/not found/i);
    expect(sent).toHaveLength(1);
  });

  it('PDF → draft item: createItem from the attached PDF runs through the harness and lands as a draft', async () => {
    answers.push(toolCall('createItem', { collection: 'invoices', data: { number: 'INV-7', total: 120 } }));
    const res = await chat({ message: 'Create an invoice from this PDF', attachments: [{ fileId: pdfId }] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('executed');
    const parts = sent[0]!.messages.at(-1)!.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'file', file: { filename: 'invoice.pdf', file_data: `data:application/pdf;base64,${PDF.toString('base64')}` } });
    const created = await db.select().from(items).where(eq(items.siteId, SITE));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: 'draft', data: { number: 'INV-7', total: 120 } });
  });

  it('extractFieldsFromPdf proposes values for known fields only and writes nothing', async () => {
    answers.push(toolCall('extractFieldsFromPdf', { fileId: pdfId, collection: 'invoices' }));
    answers.push(text(JSON.stringify({
      data: { number: 'INV-7', total: '120', scan: 'file_x', customer: 'ACME' },
      notes: 'Total read from page 1.',
    })));
    const res = await chat({ message: 'extract the invoice fields' });
    const body = (await res.json()) as { data: { status: string; data: Record<string, unknown> } };
    expect(body.data.status).toBe('executed');
    expect(body.data.data).toMatchObject({
      collection: 'invoices',
      data: { number: 'INV-7' },
      ignored: ['total', 'scan', 'customer'],
      notes: 'Total read from page 1.',
    });
    // The prompt offered only fields a document can fill.
    const request = JSON.parse((sent[1]!.messages[1]!.content as Array<{ type: string; text?: string }>).at(-1)!.text!.split('\n\n').slice(1).join('\n\n')) as { fields: Array<{ name: string }> };
    expect(request.fields.map((f) => f.name)).toEqual(['number', 'total']);
    expect(await db.select().from(items).where(eq(items.siteId, SITE))).toEqual([]);
  });

  it('refuses a file the caller cannot read, and stores nothing', async () => {
    for (const [fileId, status, code] of [
      [foreignId, 404, 'NOT_FOUND'],
      [textId, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ] as const) {
      const res = await chat({ message: 'look', attachments: [{ fileId }] });
      expect(res.status, code).toBe(status);
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe(code);
    }
    // A member without a files::read permission cannot attach at all.
    const member = await chat({ message: 'look', attachments: [{ fileId: imageId }] }, { userId: MEMBER, roleId: MEMBER_ROLE });
    expect(member.status).toBe(403);
    expect(await storedUserTurns()).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it('validates the attachment list', async () => {
    const tooMany = await chat({ message: 'x', attachments: [1, 2, 3, 4, 5].map((n) => ({ fileId: `f${n}` })) });
    expect(tooMany.status).toBe(400);
    const extra = await chat({ message: 'x', attachments: [{ fileId: imageId, url: 'https://evil.example/x.png' }] });
    expect(extra.status).toBe(400);
  });

  it('a provider without image/PDF input answers 422 before any upstream call', async () => {
    const res = await chat(
      { message: 'describe', attachments: [{ fileId: imageId }] },
      { env: { LLM_PROVIDER: 'workers-ai', WORKERS_AI_ACCOUNT_ID: 'acc', WORKERS_AI_API_TOKEN: 'tok' } },
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('LLM_ATTACHMENTS_UNSUPPORTED');
    expect(sent).toHaveLength(0);
  });
});
