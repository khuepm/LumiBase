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
import { loadCopilotHistory } from '../copilot-history';
import {
  COPILOT_TRIGGER_TURNS,
  MAX_INJECTED_CHARS,
  MAX_SKILL_BODY_CHARS,
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

  const service = (siteId = SITE) => new SiteSkillService({ db, siteId, actor: { label: 'test' } });

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

    });

    it('PATCH and activate honour the version the caller saw (409 VERSION_MISMATCH)', async () => {
      const { call } = app();
      await call('POST', '', HOUSE_STYLE);
      await call('PATCH', '/house-style', { body: 'v2 body' });

      const stale = await call('PATCH', '/house-style', { body: 'stale edit', expectedVersion: 1 });
      expect(stale.status).toBe(409);
      expect(stale.json.errors?.[0]).toMatchObject({ code: 'VERSION_MISMATCH', currentVersion: 2 });
      const fresh = await call('PATCH', '/house-style', { body: 'v3 body', expectedVersion: 2 });
      expect(fresh.json.data).toMatchObject({ version: 3, body: 'v3 body' });

      // Activating the version the reviewer looked at, after someone else edited it, is refused.
      const lateActivate = await call('POST', '/house-style/activate', { version: 2 });
      expect(lateActivate.status).toBe(409);
      expect(lateActivate.json.errors?.[0]).toMatchObject({ code: 'VERSION_MISMATCH', currentVersion: 3 });
      expect((await call('GET', '/house-style')).json.data.status).toBe('draft');
      expect((await call('POST', '/house-style/activate', { version: 3 })).json.data).toMatchObject({ status: 'active', version: 3 });
      // Both fields stay optional.
      expect((await call('POST', '/house-style/archive')).status).toBe(200);
      expect((await call('POST', '/house-style/activate', { version: 0 })).status).toBe(400);
    });

    it('a skill that was ever active cannot be deleted — archive it; a never-active draft can', async () => {
      const { call } = app();
      const live = await call('POST', '', HOUSE_STYLE);
      await call('POST', '/house-style/activate');
      await call('POST', '/house-style/draft');
      const refused = await call('DELETE', '/house-style');
      expect(refused.status).toBe(409);
      expect(refused.json.errors?.[0]?.code).toBe('SKILL_HAS_BEEN_ACTIVE');
      expect(refused.json.errors?.[0]?.message).toMatch(/archive/i);
      expect(await db.select().from(siteSkillVersions).where(eq(siteSkillVersions.skillId, live.json.data.id))).toHaveLength(1);

      const draft = await call('POST', '', { ...HOUSE_STYLE, slug: 'scratch' });
      const removed = await call('DELETE', '/scratch');
      expect(removed.status).toBe(200);
      expect(await db.select().from(siteSkillVersions).where(eq(siteSkillVersions.skillId, draft.json.data.id))).toHaveLength(0);
      const [audit] = await db.select().from(activity).where(and(eq(activity.siteId, SITE), eq(activity.action, 'site_skill.deleted')));
      expect(audit!.payload).toMatchObject({ skillId: draft.json.data.id, slug: 'scratch', wasStatus: 'draft' });
      expect(audit!.itemId).toBe(draft.json.data.id);
    });

    it('the JSON API stores the body trimmed like a parsed document, so pull → push is a no-op', async () => {
      const { call } = app();
      const created = await call('POST', '', { ...HOUSE_STYLE, body: `\n${HOUSE_STYLE.body}  \n\n` });
      expect(created.json.data.body).toBe(HOUSE_STYLE.body);
      const exported = (await call('GET', '/export')).json.data as Array<{ filename: string; content: string }>;
      const again = await call('POST', '/import', { documents: exported.map((d) => ({ path: d.filename, content: d.content })) });
      expect(again.json.data[0]).toMatchObject({ action: 'unchanged', version: 1 });
      const whitespaceOnly = await call('PATCH', '/house-style', { body: `${HOUSE_STYLE.body}\n\n   ` });
      expect(whitespaceOnly.json).toMatchObject({ meta: { changed: false }, data: { version: 1 } });
      expect((await call('PATCH', '/house-style', { body: ' \n ' })).status).toBe(400);
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

  describe('atomic writes (review #781 item 3)', () => {
    /**
     * A BEFORE trigger that fails one statement of a write. Before the write
     * was one transaction, the statements before it stayed committed: a failed
     * `site_skills` update left version N+1 in the trail while the skill said
     * N, and every later write collided with N+1 (409) forever.
     */
    async function failing(table: string, when: string, run: () => Promise<void>) {
      await db.execute(sql.raw(`
        CREATE OR REPLACE FUNCTION lumibase_test_781_skill_reject() RETURNS trigger AS $$
        BEGIN
          IF ${when} THEN
            RAISE EXCEPTION 'skill write rejected' USING ERRCODE = 'P0781';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER lumibase_test_781_skill_reject BEFORE INSERT OR UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION lumibase_test_781_skill_reject()`));
      try {
        await run();
      } finally {
        await db.execute(sql.raw(`DROP TRIGGER IF EXISTS lumibase_test_781_skill_reject ON ${table}`));
        await db.execute(sql.raw('DROP FUNCTION IF EXISTS lumibase_test_781_skill_reject()'));
      }
    }
    const input = { ...HOUSE_STYLE, riskClass: 'low' as const, priority: 0, triggers: [], surfaces: [], tools: [], collections: [], requiredCapabilities: [] };

    it('update: a failed skill-row write leaves no orphan version and the next write succeeds', async () => {
      await service().create(input);
      await failing('lumibase_site_skills', `NEW.body = 'boom'`, async () => {
        await expect(service().update('house-style', { body: 'boom' })).rejects.toThrow();
      });
      const versions = await db.select().from(siteSkillVersions).where(eq(siteSkillVersions.siteId, SITE));
      expect(versions.map((v) => v.version)).toEqual([1]);
      expect(await db.select().from(activity).where(and(eq(activity.siteId, SITE), eq(activity.action, 'site_skill.updated')))).toHaveLength(0);

      const next = await service().update('house-style', { body: 'Second version.' });
      expect(next).toMatchObject({ changed: true, skill: { version: 2, body: 'Second version.' } });
    });

    it('update: a failed audit row rolls back the version and the skill row', async () => {
      await service().create(input);
      await failing('lumibase_activity', `NEW.site_id = '${SITE}' AND NEW.action = 'site_skill.updated'`, async () => {
        await expect(service().update('house-style', { body: 'audited' })).rejects.toThrow();
      });
      expect((await service().get('house-style')).version).toBe(1);
      expect(await db.select().from(siteSkillVersions).where(eq(siteSkillVersions.siteId, SITE))).toHaveLength(1);
    });

    it('create: a failed version insert leaves no skill without its v1, and a retry succeeds', async () => {
      await failing('lumibase_site_skill_versions', `NEW.site_id = '${SITE}'`, async () => {
        await expect(service().create(input)).rejects.toThrow();
      });
      expect(await db.select().from(siteSkills).where(eq(siteSkills.siteId, SITE))).toHaveLength(0);
      const created = await service().create(input);
      expect(created.version).toBe(1);
      expect(await db.select().from(siteSkillVersions).where(eq(siteSkillVersions.skillId, created.id))).toHaveLength(1);
    });
  });

  describe('guards', () => {
    it('a principal that is not a control-plane admin can read but not write', async () => {
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
        expect(res.json.errors?.[0]?.message).toBe('Writing Site Skills requires a control-plane admin.');
      }
      const [row] = await db.select().from(siteSkills).where(eq(siteSkills.siteId, SITE));
      expect(row).toMatchObject({ status: 'draft', body: HOUSE_STYLE.body, version: 1 });
    });

    it('riskClass is a stored label: an admin writes and activates a high-risk skill like any other', async () => {
      const { call } = app();
      const created = await call('POST', '', { ...HOUSE_STYLE, riskClass: 'high' });
      expect(created.json.data).toMatchObject({ riskClass: 'high', status: 'draft' });
      expect((await call('POST', '/house-style/activate')).json.data.status).toBe('active');
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
          { path: 'huge.md', content: doc('huge', 'x'.repeat(12_001)) },
          { path: 'ok.md', content: doc('fine', 'ok') },
        ],
      });
      expect(mixed.status).toBe(200);
      expect(mixed.json.data.map((r: { action: string }) => r.action)).toEqual(['error', 'error', 'created']);
    });

    it('a content change to an active skill is refused per document unless updateActive is set', async () => {
      const { call } = app();
      await call('POST', '/import', { activate: true, documents: [{ content: doc('alpha', 'Alpha rules') }, { content: doc('beta', 'Beta rules') }] });

      // The install path: no updateActive. The active skill is untouched; the rest of the batch still lands.
      const install = await call('POST', '/import', {
        documents: [{ content: doc('alpha', 'Alpha rules v2') }, { content: doc('beta', 'Beta rules') }, { content: doc('gamma', 'Gamma rules') }],
      });
      expect(install.json.data).toMatchObject([
        { slug: 'alpha', action: 'error', code: 'ACTIVE_SKILL_CHANGE' },
        { slug: 'beta', action: 'unchanged' },
        { slug: 'gamma', action: 'created', status: 'draft' },
      ]);
      expect((await call('GET', '/alpha')).json.data).toMatchObject({ version: 1, body: 'Alpha rules', status: 'active' });
      // A dry run reports the same refusal.
      const plan = await call('POST', '/import', { dryRun: true, documents: [{ content: doc('alpha', 'Alpha rules v2') }] });
      expect(plan.json.data[0]).toMatchObject({ action: 'error', code: 'ACTIVE_SKILL_CHANGE' });

      // The push path opts in and updates the live skill.
      const push = await call('POST', '/import', { updateActive: true, documents: [{ content: doc('alpha', 'Alpha rules v2') }] });
      expect(push.json.data[0]).toMatchObject({ action: 'updated', version: 2, status: 'active' });
      expect((await call('GET', '/alpha')).json.data.body).toBe('Alpha rules v2');
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

    it('a body at the size cap is always injectable on its own', async () => {
      const body = 'x'.repeat(MAX_SKILL_BODY_CHARS);
      expect(MAX_SKILL_BODY_CHARS).toBe(MAX_INJECTED_CHARS);
      await activate({ slug: 'big', name: 'Big', body });
      const resolved = await service().resolve({ surface: 'copilot' });
      expect(resolved.skills.map((skill) => skill.slug)).toEqual(['big']);
      expect(resolved.skipped).toEqual([]);
      const { call } = app();
      expect((await call('POST', '', { slug: 'too-big', name: 'Too big', body: `${body}x` })).status).toBe(400);
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

    it('Copilot: triggers match the latest user turns of the loaded window, on both chat paths', async () => {
      const skill = await activate({ ...HOUSE_STYLE, triggers: ['headline'] });
      const [conversation] = await db.insert(aiConversations).values({ siteId: SITE, title: 't' }).returning();
      const at = (seconds: number) => new Date(Date.UTC(2026, 10, 12, 0, 0, seconds));
      await db.insert(aiMessages).values([
        { conversationId: conversation!.id, role: 'user', content: 'Write a headline for the launch post', createdAt: at(1) },
        { conversationId: conversation!.id, role: 'assistant', content: 'Launch day is here', createdAt: at(2) },
        { conversationId: conversation!.id, role: 'user', content: 'Make it shorter', createdAt: at(3) },
      ]);
      const history = await loadCopilotHistory(db, conversation!.id);

      // The follow-up alone does not mention the trigger; the conversation does.
      expect((await resolveCopilotPlaybooks({ db, siteId: SITE }, { text: 'Make it shorter', capabilities: [] })).applied).toEqual([]);
      const sync = await resolveCopilotPlaybooks({ db, siteId: SITE }, { text: 'Make it shorter', history, capabilities: [] });
      expect(sync.applied).toEqual([{ slug: skill.slug, version: 1, hash: skill.hash }]);

      // Only the newest COPILOT_TRIGGER_TURNS user turns count.
      const old = Array.from({ length: COPILOT_TRIGGER_TURNS }, (_, i) => ({ role: 'user' as const, content: `unrelated ${i}` }));
      const stale = await resolveCopilotPlaybooks(
        { db, siteId: SITE },
        { text: 'Make it shorter', history: [{ role: 'user', content: 'Write a headline' }, ...old], capabilities: [] },
      );
      expect(stale.applied).toEqual([]);

      // The queued worker loads the same window and matches the same way.
      const { createPendingRun } = await import('../flow-run-service');
      const run = await createPendingRun(db, { siteId: SITE, runType: 'ai_chat', input: {} });
      const bodies: Array<Record<string, unknown>> = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Launch!' } }] }), { status: 200 });
      }) as typeof fetch;
      try {
        await executeAiChatRun(
          db,
          { kind: 'ai_chat', siteId: SITE, runId: run.id, conversationId: conversation!.id, message: 'Make it shorter', userId: null, userCapabilities: [] },
          undefined,
          { LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' },
        );
      } finally {
        globalThis.fetch = realFetch;
      }
      const system = (bodies[0]!['messages'] as Array<{ role: string; content: string }>)[0]!;
      expect(system.content).toContain('Never use the word "utilize".');
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
