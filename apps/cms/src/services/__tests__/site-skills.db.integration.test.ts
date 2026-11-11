import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activity, aiConversations, aiMessages, sites, siteSkills, siteSkillVersions, type Database } from '@lumibase/database';
import type { RuntimeContext } from '@lumibase/runtime';
import type { AppEnv } from '../../env';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { siteSkillsRouter } from '../../routes/site-skills';
import { AISecureHarness } from '../ai-harness';
import { executeAiChatRun } from '../ai-chat-run-worker';
import { COPILOT_SYSTEM_PROMPT, type ConfiguredLLM, type LLMChatOptions } from '../llm-provider';
import { McpService, type McpHarnessPort } from '../mcp-service';
import { SchemaService } from '../schema-service';
import {
  SITE_SKILLS_PREAMBLE,
  SiteSkillService,
  resolveCopilotPlaybooks,
} from '../site-skill-service';

/**
 * Site Skills (#712) against real PostgreSQL: persistence + version trail,
 * route guards, tenant isolation, and the three injection surfaces.
 */

const SITE = 'site-skills-a';
const OTHER = 'site-skills-b';

const HOUSE_STYLE = {
  slug: 'house-style',
  name: 'House style',
  description: 'Voice rules',
  body: 'Write in active voice. Never use the word "utilize".',
};

describe.skipIf(!hasDbIntegrationUrl)('Site Skills — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('site-skills');
  });
  async function clean() {
    for (const site of [SITE, OTHER]) await db.delete(sites).where(eq(sites.id, site));
  }
  beforeEach(async () => {
    await clean();
    const organizationId = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId, id: SITE, name: 'Skills A' },
      { organizationId, id: OTHER, name: 'Skills B' },
    ]);
  });
  afterAll(async () => {
    if (db) await clean();
  });

  function app(roles: string[] = ['admin'], siteId = SITE) {
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('auth', { roles, raw: { dev: true } });
      c.set('runtime', {} as RuntimeContext);
      await next();
    });
    hono.route('/skills', siteSkillsRouter);
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await hono.request(
        `/skills${path}`,
        {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        { LUMIBASE_ENV: 'development' },
      );
      return { status: res.status, json: (await res.json()) as { data?: any; meta?: any; errors?: Array<{ code: string; message: string }> } };
    };
    return { call };
  }

  const service = (siteId = SITE, admin = true) =>
    new SiteSkillService({ db, siteId, actor: { label: 'test', admin } });

  /** A fake LLM that records the options of every call. */
  function recordingLLM(reply: string) {
    const calls: Array<LLMChatOptions | undefined> = [];
    const llm: ConfiguredLLM = {
      name: 'fake',
      model: 'fake-1',
      provider: {
        chat: async (_messages, options) => {
          calls.push(options);
          return { content: reply, toolCalls: [] };
        },
      },
    };
    return { llm, calls };
  }

  describe('lifecycle and version trail', () => {
    it('creates a draft with version 1, a version row and an audit entry', async () => {
      const { call } = app();
      const created = await call('POST', '', { ...HOUSE_STYLE, source: 'studio', changeNote: 'first cut' });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      expect(created.json.data).toMatchObject({ slug: 'house-style', status: 'draft', version: 1, source: 'studio', riskClass: 'low' });
      expect(created.json.data.hash).toMatch(/^sha256:/);

      const versions = await call('GET', '/house-style/versions');
      expect(versions.json.data).toHaveLength(1);
      expect(versions.json.data[0]).toMatchObject({ version: 1, hash: created.json.data.hash, source: 'studio', changeNote: 'first cut' });
      expect(versions.json.data[0].snapshot.body).toBe(HOUSE_STYLE.body);

      const audit = await db.select().from(activity).where(and(eq(activity.siteId, SITE), eq(activity.action, 'site_skill.created')));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.payload).toMatchObject({ slug: 'house-style', version: 1 });
    });

    it('a content change appends a version; an identical PATCH writes nothing; omitted fields survive', async () => {
      const { call } = app();
      await call('POST', '', { ...HOUSE_STYLE, priority: 7, triggers: ['headline'] });

      const edited = await call('PATCH', '/house-style', { body: 'Write in active voice. Prefer short sentences.' });
      expect(edited.json.meta).toEqual({ changed: true });
      // patchSchema: a PATCH carrying only `body` must not reset priority/triggers to their defaults.
      expect(edited.json.data).toMatchObject({ version: 2, priority: 7, triggers: ['headline'] });

      const same = await call('PATCH', '/house-style', { body: 'Write in active voice. Prefer short sentences.' });
      expect(same.json.meta).toEqual({ changed: false });
      expect(same.json.data.version).toBe(2);
      expect(await db.select().from(siteSkillVersions).where(eq(siteSkillVersions.siteId, SITE))).toHaveLength(2);

      const renamed = await call('PATCH', '/house-style', { slug: 'other' });
      expect(renamed.status).toBe(400);
    });

    it('restores an old version as a new version and audits activation', async () => {
      const { call } = app();
      const v1 = await call('POST', '', HOUSE_STYLE);
      await call('PATCH', '/house-style', { body: 'v2 body' });
      const restored = await call('POST', '/house-style/versions/1/restore');
      expect(restored.json.data).toMatchObject({ version: 3, body: HOUSE_STYLE.body, hash: v1.json.data.hash });
      expect((await call('POST', '/house-style/versions/9/restore')).status).toBe(404);

      const active = await call('POST', '/house-style/activate');
      expect(active.json.data).toMatchObject({ status: 'active' });
      expect(active.json.data.activatedAt).toBeTruthy();
      const audit = await db.select().from(activity).where(and(eq(activity.siteId, SITE), eq(activity.action, 'site_skill.activated')));
      expect(audit[0]!.payload).toMatchObject({ slug: 'house-style', version: 3, fromStatus: 'draft', toStatus: 'active' });

      const removed = await call('DELETE', '/house-style');
      expect(removed.status).toBe(200);
      expect(await db.select().from(siteSkillVersions).where(eq(siteSkillVersions.siteId, SITE))).toHaveLength(0);
    });

    it('rejects a duplicate slug with 409 and invalid input with 400', async () => {
      const { call } = app();
      await call('POST', '', HOUSE_STYLE);
      expect((await call('POST', '', HOUSE_STYLE)).status).toBe(409);
      expect((await call('POST', '', { ...HOUSE_STYLE, slug: 'Bad Slug' })).status).toBe(400);
      expect((await call('GET', '?status=nonsense')).status).toBe(400);
      expect((await call('GET', '/missing')).status).toBe(404);
    });
  });

  describe('guards', () => {
    it('a principal without skills:write can read but not write', async () => {
      await service().create({ ...HOUSE_STYLE, riskClass: 'low', priority: 0, triggers: [], surfaces: [], tools: [], collections: [], requiredCapabilities: [] });
      const { call } = app(['editor']);
      expect((await call('GET', '')).json.data).toHaveLength(1);
      for (const [method, path, body] of [
        ['POST', '', { ...HOUSE_STYLE, slug: 'x' }],
        ['PATCH', '/house-style', { body: 'hijacked' }],
        ['POST', '/house-style/activate', undefined],
        ['POST', '/import', { documents: [{ content: '# x' }] }],
        ['POST', '/house-style/versions/1/restore', undefined],
        ['DELETE', '/house-style', undefined],
      ] as const) {
        const res = await call(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.json.errors?.[0]?.code).toBe('FORBIDDEN');
      }
      const [row] = await db.select().from(siteSkills).where(eq(siteSkills.siteId, SITE));
      expect(row).toMatchObject({ status: 'draft', body: HOUSE_STYLE.body, version: 1 });
    });

    it('high-risk skills are admin-only in every direction', async () => {
      const input = { ...HOUSE_STYLE, riskClass: 'high' as const, priority: 0, triggers: [], surfaces: [], tools: [], collections: [], requiredCapabilities: [] };
      const writer = service(SITE, false);
      await expect(writer.create(input)).rejects.toMatchObject({ code: 'RISK_REQUIRES_ADMIN', status: 403 });

      await service(SITE, true).create(input);
      await expect(writer.update('house-style', { body: 'softened' })).rejects.toMatchObject({ code: 'RISK_REQUIRES_ADMIN' });
      await expect(writer.update('house-style', { riskClass: 'low' })).rejects.toMatchObject({ code: 'RISK_REQUIRES_ADMIN' });
      await expect(writer.setStatus('house-style', 'active')).rejects.toMatchObject({ code: 'RISK_REQUIRES_ADMIN' });
      await expect(writer.remove('house-style')).rejects.toMatchObject({ code: 'RISK_REQUIRES_ADMIN' });

      // A writer may not escalate their own low-risk skill either.
      await writer.create({ ...input, slug: 'mine', riskClass: 'low' });
      await expect(writer.update('mine', { riskClass: 'high' })).rejects.toMatchObject({ code: 'RISK_REQUIRES_ADMIN' });
      await expect(writer.setStatus('mine', 'active')).resolves.toMatchObject({ status: 'active' });
    });
  });

  describe('tenant isolation', () => {
    it('site B never sees, matches or mutates site A skills', async () => {
      const a = app(['admin'], SITE);
      const b = app(['admin'], OTHER);
      await a.call('POST', '', HOUSE_STYLE);
      await a.call('POST', '/house-style/activate');

      expect((await b.call('GET', '')).json.data).toEqual([]);
      expect((await b.call('GET', '/house-style')).status).toBe(404);
      expect((await b.call('PATCH', '/house-style', { body: 'x' })).status).toBe(404);
      expect((await b.call('DELETE', '/house-style')).status).toBe(404);
      expect((await b.call('GET', '/export')).json.data).toEqual([]);
      expect((await b.call('POST', '/match', { surface: 'copilot', text: 'anything' })).json.data.skills).toEqual([]);
      expect(await service(OTHER).resolve({ surface: 'generation' })).toMatchObject({ skills: [], prompt: '' });

      // The same slug is free on the other site, and stays separate.
      expect((await b.call('POST', '', { ...HOUSE_STYLE, body: 'Site B rules' })).status).toBe(201);
      expect((await a.call('GET', '/house-style')).json.data.body).toBe(HOUSE_STYLE.body);
    });
  });

  describe('import / export', () => {
    const doc = (slug: string, body: string, extra = '') => `---\nslug: ${slug}\nname: ${slug}\n${extra}---\n\n${body}\n`;

    it('upserts by slug, reports per document, and round-trips through export', async () => {
      const { call } = app();
      const first = await call('POST', '/import', {
        source: 'cli',
        sourceRef: 'repo/skills',
        documents: [
          { path: 'a.skill.md', content: doc('alpha', 'Alpha rules') },
          { path: 'Beta Skill.md', content: '# Beta\n\nBeta rules' },
          { path: 'broken.md', content: '---\nslug: broken\nnope: 1\n---\nbody' },
          { path: 'dup.md', content: doc('alpha', 'again') },
        ],
      });
      expect(first.status).toBe(200);
      expect(first.json.meta).toMatchObject({ created: 2, updated: 0, unchanged: 0, errors: 2, dryRun: false });
      expect(first.json.data.map((r: { action: string }) => r.action)).toEqual(['created', 'created', 'error', 'error']);
      expect(first.json.data[1]).toMatchObject({ slug: 'beta-skill', status: 'draft', version: 1 });
      expect(first.json.data[2]).toMatchObject({ code: 'INVALID_DOCUMENT' });
      expect(first.json.data[3]).toMatchObject({ code: 'DUPLICATE_SLUG' });

      const exported = await call('GET', '/export');
      expect(exported.json.data.map((d: { filename: string }) => d.filename)).toEqual(['alpha.skill.md', 'beta-skill.skill.md']);

      // Re-importing the export is a no-op: pull → push must not churn versions.
      const again = await call('POST', '/import', {
        documents: exported.json.data.map((d: { filename: string; content: string }) => ({ path: d.filename, content: d.content })),
      });
      expect(again.json.meta).toMatchObject({ created: 0, updated: 0, unchanged: 2, errors: 0 });

      const plan = await call('POST', '/import', { dryRun: true, activate: true, documents: [{ content: doc('alpha', 'Alpha rules v2') }, { content: doc('gamma', 'new') }] });
      expect(plan.json.data).toMatchObject([
        { slug: 'alpha', action: 'updated', version: 2, status: 'active' },
        { slug: 'gamma', action: 'created', version: 1, status: 'active' },
      ]);
      // Dry run wrote nothing.
      expect((await call('GET', '/alpha')).json.data).toMatchObject({ version: 1, status: 'draft' });
      expect((await call('GET', '/gamma')).status).toBe(404);

      const applied = await call('POST', '/import', { activate: true, source: 'package', sourceRef: '@acme/skills@1.2.0', documents: [{ content: doc('alpha', 'Alpha rules v2') }] });
      expect(applied.json.data[0]).toMatchObject({ action: 'updated', version: 2, status: 'active' });
      const [version] = (await call('GET', '/alpha/versions')).json.data;
      expect(version).toMatchObject({ version: 2, source: 'package', sourceRef: '@acme/skills@1.2.0' });
    });

    it('an activation-only import is reported as a change, and bad documents fail alone', async () => {
      const { call } = app();
      await call('POST', '/import', { documents: [{ content: doc('alpha', 'Alpha rules') }] });
      // Same content, but the skill is a draft: `push --check --activate` must not read "unchanged".
      const plan = await call('POST', '/import', { dryRun: true, activate: true, documents: [{ content: doc('alpha', 'Alpha rules') }] });
      expect(plan.json.data[0]).toMatchObject({ action: 'updated', version: 1, status: 'active' });
      const real = await call('POST', '/import', { activate: true, documents: [{ content: doc('alpha', 'Alpha rules') }] });
      expect(real.json.data[0]).toMatchObject({ action: 'updated', version: 1, status: 'active' });
      const settled = await call('POST', '/import', { activate: true, documents: [{ content: doc('alpha', 'Alpha rules') }] });
      expect(settled.json.data[0]).toMatchObject({ action: 'unchanged' });

      // An empty and an over-long document are per-document errors, not a 400 for the batch.
      const mixed = await call('POST', '/import', {
        documents: [
          { path: 'empty.md', content: '' },
          { path: 'huge.md', content: doc('huge', 'x'.repeat(20_001)) },
          { path: 'ok.md', content: doc('fine', 'ok') },
        ],
      });
      expect(mixed.status).toBe(200);
      expect(mixed.json.data.map((r: { action: string }) => r.action)).toEqual(['error', 'error', 'created']);
    });
  });

  describe('injection', () => {
    async function activate(input: Record<string, unknown>) {
      const { call } = app();
      const created = await call('POST', '', input);
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      await call('POST', `/${created.json.data.slug}/activate`);
      return created.json.data as { slug: string; version: number; hash: string };
    }

    it('draft and archived skills are never injected', async () => {
      const { call } = app();
      await call('POST', '', HOUSE_STYLE);
      expect((await service().resolve({ surface: 'copilot' })).prompt).toBe('');
      await call('POST', '/house-style/activate');
      expect((await service().resolve({ surface: 'copilot' })).skills).toHaveLength(1);
      await call('POST', '/house-style/archive');
      expect((await service().resolve({ surface: 'copilot' })).prompt).toBe('');
    });

    it('generation tools: the playbook joins the instructions and is stamped on the result', async () => {
      const skill = await activate({ ...HOUSE_STYLE, tools: ['aiContentAssist'] });
      await activate({ slug: 'seed-only', name: 'Seed only', body: 'Seed rules', tools: ['generateSeedData'] });
      const { llm, calls } = recordingLLM('{"content":"Generated."}');
      const harness = new AISecureHarness({ db, siteId: SITE, schemaService: new SchemaService({ db, siteId: SITE }), llm });

      const result = await harness.execute(
        'aiContentAssist',
        { collection: 'posts', fieldName: 'intro', instruction: 'Write an intro' },
        ['*'],
      );
      expect(result.status, JSON.stringify(result)).toBe('executed');
      const options = calls.at(-1)!;
      expect(options?.tools).toBe(false);
      expect(options?.systemPrompt).toContain('You write CMS field content.');
      expect(options?.systemPrompt).toContain(SITE_SKILLS_PREAMBLE);
      expect(options?.systemPrompt).toContain('Never use the word "utilize".');
      // Scoped to another tool: not injected here.
      expect(options?.systemPrompt).not.toContain('Seed rules');
      expect((result.data as { meta: { siteSkills: unknown } }).meta.siteSkills).toEqual([
        { slug: skill.slug, version: 1, hash: skill.hash },
      ]);
    });

    it('generation tools on a site without active skills send the unchanged instructions', async () => {
      await activate(HOUSE_STYLE); // lives on SITE, not OTHER
      const { llm, calls } = recordingLLM('{"content":"Generated."}');
      const harness = new AISecureHarness({ db, siteId: OTHER, schemaService: new SchemaService({ db, siteId: OTHER }), llm });
      const result = await harness.execute('aiContentAssist', { collection: 'posts', fieldName: 'intro', instruction: 'x' }, ['*']);
      expect(result.status).toBe('executed');
      expect(calls.at(-1)?.systemPrompt).not.toContain('site-skill');
      expect((result.data as { meta: Record<string, unknown> }).meta).not.toHaveProperty('siteSkills');
    });

    it('Copilot: matching playbooks extend the Copilot prompt; no match leaves the default', async () => {
      const skill = await activate({ ...HOUSE_STYLE, triggers: ['headline'] });
      await activate({ slug: 'publishers', name: 'Publishers', body: 'Publishing checklist', requiredCapabilities: ['items:write'] });

      const none = await resolveCopilotPlaybooks({ db, siteId: SITE }, { text: 'list collections', capabilities: [] });
      expect(none).toEqual({ applied: [] });

      const hit = await resolveCopilotPlaybooks({ db, siteId: SITE }, { text: 'Write a HEADLINE', capabilities: ['items:read'] });
      expect(hit.applied).toEqual([{ slug: skill.slug, version: 1, hash: skill.hash }]);
      expect(hit.systemPrompt!.startsWith(COPILOT_SYSTEM_PROMPT)).toBe(true);
      expect(hit.systemPrompt).toContain('Never use the word "utilize".');
      expect(hit.systemPrompt).not.toContain('Publishing checklist');

      const writer = await resolveCopilotPlaybooks({ db, siteId: SITE }, { text: 'hello', capabilities: ['items:write'] });
      expect(writer.applied.map((s) => s.slug)).toEqual(['publishers']);
    });

    it('Copilot async worker sends the same prompt and records the applied skills', async () => {
      const skill = await activate(HOUSE_STYLE);
      const [conversation] = await db.insert(aiConversations).values({ siteId: SITE, title: 't' }).returning();
      await db.insert(aiMessages).values({ conversationId: conversation!.id, role: 'user', content: 'Write a headline' });
      const { createPendingRun } = await import('../flow-run-service');
      const run = await createPendingRun(db, { siteId: SITE, runType: 'ai_chat', input: {} });

      const bodies: Array<Record<string, unknown>> = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Here is a headline.' } }] }), { status: 200 });
      }) as typeof fetch;
      try {
        await executeAiChatRun(
          db,
          { kind: 'ai_chat', siteId: SITE, runId: run.id, conversationId: conversation!.id, message: 'Write a headline', userId: null, userCapabilities: [] },
          undefined,
          { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' },
        );
      } finally {
        globalThis.fetch = realFetch;
      }
      const system = (bodies[0]!['messages'] as Array<{ role: string; content: string }>)[0]!;
      expect(system.role).toBe('system');
      expect(system.content.startsWith(COPILOT_SYSTEM_PROMPT)).toBe(true);
      expect(system.content).toContain('Never use the word "utilize".');

      const [assistant] = await db
        .select()
        .from(aiMessages)
        .where(and(eq(aiMessages.conversationId, conversation!.id), eq(aiMessages.role, 'assistant')));
      expect((assistant!.metadata as { siteSkills: unknown }).siteSkills).toEqual([
        { slug: skill.slug, version: 1, hash: skill.hash },
      ]);
    });

    it('MCP prompts/list and prompts/get expose active skills, filtered by capability', async () => {
      const skill = await activate({ ...HOUSE_STYLE, triggers: ['headline'] });
      await activate({ slug: 'publishers', name: 'Publishers', body: 'Publishing checklist', requiredCapabilities: ['items:write'] });
      await activate({ slug: 'copilot-only', name: 'Copilot only', body: 'x', surfaces: ['copilot'] });
      const skills = new SiteSkillService({ db, siteId: SITE });
      const port: McpHarnessPort = {
        listTools: async () => [],
        execute: async () => ({ status: 'denied' }),
        listPrompts: async (caps) => (await skills.listForMcp(caps)).map((s) => ({ name: s.slug, title: s.name, description: s.description })),
        getPrompt: async (name, caps) => {
          const s = (await skills.listForMcp(caps)).find((entry) => entry.slug === name);
          return s ? { name: s.slug, title: s.name, description: s.description, text: s.body, version: s.version, hash: s.hash } : null;
        },
      };
      const mcp = new McpService(port);
      const rpc = async (method: string, params: Record<string, unknown> | undefined, caps: string[]) =>
        (await mcp.handle({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, caps))!;

      const init = await rpc('initialize', {}, []);
      expect((init.result as { capabilities: unknown }).capabilities).toEqual({ tools: { listChanged: false }, prompts: { listChanged: false } });

      const reader = await rpc('prompts/list', undefined, ['items:read']);
      expect((reader.result as { prompts: Array<{ name: string }> }).prompts).toEqual([
        { name: 'house-style', title: 'House style', description: 'Voice rules' },
      ]);
      const writer = await rpc('prompts/list', undefined, ['items:write']);
      expect((writer.result as { prompts: Array<{ name: string }> }).prompts.map((p) => p.name)).toEqual(['house-style', 'publishers']);

      const got = await rpc('prompts/get', { name: 'house-style' }, ['items:read']);
      expect(got.result).toEqual({
        description: 'Voice rules',
        messages: [{ role: 'user', content: { type: 'text', text: HOUSE_STYLE.body } }],
        _meta: { 'lumibase/siteSkill': { slug: skill.slug, version: 1, hash: skill.hash } },
      });
      // Gated and missing prompts answer identically.
      const gated = await rpc('prompts/get', { name: 'publishers' }, ['items:read']);
      const missing = await rpc('prompts/get', { name: 'nope' }, ['items:read']);
      expect(gated.error?.code).toBe(-32602);
      expect(gated.error?.message.replace('publishers', 'X')).toBe(missing.error?.message.replace('nope', 'X'));
    });

    it('resolveSafe degrades to no playbooks when the tables cannot be read', async () => {
      const broken = new SiteSkillService({ db: {} as Database, siteId: SITE });
      await expect(broken.resolveSafe({ surface: 'copilot' })).resolves.toEqual({ skills: [], skipped: [], prompt: '' });
      await expect(broken.resolve({ surface: 'copilot' })).rejects.toBeTruthy();
    });
  });
});
