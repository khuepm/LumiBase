import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { eq, inArray } from 'drizzle-orm';
import { apiKeys, organizations, settings, siteSkills, sites, userSites, users, type Database } from '@lumibase/database';
import { MemoryCacheProvider } from '@lumibase/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import type { AppEnv } from '../../env';
import { withTenant } from '../../middleware/tenant';
import { withAuth } from '../../middleware/auth';
import { withSiteMembership } from '../../middleware/site-membership';
import { withStudioAccess } from '../../middleware/studio-access';
import { withControlPlaneAccessGuard } from '../../middleware/control-plane-access-guard';
import { createPlaintextToken } from '../../services/api-key-token';
import { CONTENT_OS_SETTINGS_KEY } from '../../services/feature-flags';
import type { GovernedCapabilityResolution } from '../../services/governed-capabilities';
import { SiteSkillService } from '../../services/site-skill-service';
import { provisionSite } from '../../services/site-provisioning';
import { mcpRouter } from '../mcp';
import { siteSkillsRouter } from '../site-skills';

/**
 * Who may read and write Site Skills (#712, review of #781 items 1 and 2),
 * through the real middleware chain: tenant → auth → membership → studio
 * access → control-plane guard → router.
 *
 * - REST reads sit behind the control-plane guard, so only principals it
 *   admits can read skill bodies. MCP is not a control-plane path, so
 *   `prompts/*` must apply the same rule itself — otherwise any MCP caller on
 *   the site reads every unscoped playbook.
 * - Every skill write needs a control-plane admin. There is no delegated
 *   writer: a grant that carries a `skills:write` string but is not admin is
 *   refused, even on a mount the guard does not cover.
 */

const ORG = 'org_781_skills';
const SITE = 'site_781_skills';
const ADMIN = 'user_781_admin';
const MEMBER = 'user_781_member';
const secret = 'site-skills-access-test-signing-key';

/** Lets one test hand the router a grant no real principal can produce today. */
const grantOverride = vi.hoisted(() => ({ value: null as GovernedCapabilityResolution | null }));
vi.mock('../../services/governed-capabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/governed-capabilities')>();
  return {
    ...real,
    resolveRequestCapabilities: (c: Parameters<typeof real.resolveRequestCapabilities>[0]) =>
      grantOverride.value ? Promise.resolve(grantOverride.value) : real.resolveRequestCapabilities(c),
  };
});

const HOUSE_STYLE = {
  slug: 'house-style',
  name: 'House style',
  description: 'Voice rules',
  riskClass: 'low' as const,
  priority: 0,
  triggers: [],
  surfaces: [],
  tools: [],
  collections: [],
  requiredCapabilities: [],
  body: 'Write in active voice. Never use the word "utilize".',
};

describe.skipIf(!hasDbIntegrationUrl)('Site Skills access — real middleware chain', () => {
  let db: Database;
  let app: Hono<AppEnv>;
  let admin: string;
  let member: string;
  let siteKey: string;

  async function jwt(userId: string) {
    return new SignJWT({ userId, siteId: SITE, tokenVersion: 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('studio')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(secret));
  }

  async function request(path: string, bearer: string, method = 'GET', body?: unknown) {
    const res = await app.request(
      path,
      {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'X-Lumi-Site': SITE },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { JWT_SECRET: secret } as AppEnv['Bindings'],
    );
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as any };
  }

  const rpc = (bearer: string, method: string, params?: Record<string, unknown>) =>
    request('/api/v1/mcp', bearer, 'POST', { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });

  async function clean() {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(organizations).where(eq(organizations.id, ORG));
    await db.delete(users).where(inArray(users.id, [ADMIN, MEMBER]));
  }

  beforeAll(async () => {
    db = await connectDbIntegration('site-skills-access');
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('runtime', { cache: new MemoryCacheProvider() } as never);
      c.set('requestId', 'req_781_skills');
      await next();
    });
    app.use('*', withTenant(), withAuth(), withSiteMembership(), withStudioAccess(), withControlPlaneAccessGuard());
    app.route('/api/v1/agent/skills', siteSkillsRouter);
    app.route('/api/v1/mcp', mcpRouter);
    // The same router on a path the control-plane guard does not cover: the
    // router's own write check must hold without the guard in front of it.
    app.route('/api/v1/unguarded/skills', siteSkillsRouter);
  });

  beforeEach(async () => {
    grantOverride.value = null;
    await clean();
    await db.insert(organizations).values({ id: ORG, slug: ORG, name: '781 skills' });
    await db.insert(users).values([ADMIN, MEMBER].map((id) => ({ id, email: `${id}@example.test`, status: 'active' })));
    const { administratorRoleId, memberRoleId } = await provisionSite(db, { id: SITE, name: '781 skills', organizationId: ORG });
    await db.insert(userSites).values([
      { userId: ADMIN, siteId: SITE, roleId: administratorRoleId },
      { userId: MEMBER, siteId: SITE, roleId: memberRoleId },
    ]);
    await db
      .insert(settings)
      .values({ siteId: SITE, key: CONTENT_OS_SETTINGS_KEY, scope: 'site', value: { mcp: true } })
      .onConflictDoUpdate({ target: [settings.siteId, settings.key], set: { value: { mcp: true } } });
    const site = await createPlaintextToken();
    await db.insert(apiKeys).values({ id: 'key_781_site', name: '781 site key', siteId: SITE, prefix: site.prefix, tokenHash: site.tokenHash });
    siteKey = site.token;
    [admin, member] = await Promise.all([jwt(ADMIN), jwt(MEMBER)]);

    // An unscoped, active skill: empty surfaces and requiredCapabilities, so
    // the per-skill filter alone would offer it to every caller.
    const skills = new SiteSkillService({ db, siteId: SITE, actor: { label: 'test' } });
    await skills.create(HOUSE_STYLE);
    await skills.setStatus('house-style', 'active');
  });

  afterAll(async () => {
    if (db) await clean();
  });

  describe('MCP prompts are served only to principals that can read skills over REST', () => {
    it('a control-plane admin lists and reads the playbook', async () => {
      expect((await request('/api/v1/agent/skills', admin)).status).toBe(200);
      const list = await rpc(admin, 'prompts/list');
      expect(list.status).toBe(200);
      expect(list.json.result.prompts.map((p: { name: string }) => p.name)).toEqual(['house-style']);
      const got = await rpc(admin, 'prompts/get', { name: 'house-style' });
      expect(got.json.result.messages[0].content.text).toBe(HOUSE_STYLE.body);
    });

    it.each([
      ['a non-admin site member', () => member],
      ['a low-privilege site API key', () => siteKey],
    ])('%s gets no prompts, and prompts/get answers like an unknown name', async (_label, bearer) => {
      // The premise: REST refuses this principal.
      expect((await request('/api/v1/agent/skills', bearer())).status).toBe(403);

      const list = await rpc(bearer(), 'prompts/list');
      expect(list.status, JSON.stringify(list.json)).toBe(200);
      expect(list.json.result.prompts).toEqual([]);

      const got = await rpc(bearer(), 'prompts/get', { name: 'house-style' });
      const unknown = await rpc(bearer(), 'prompts/get', { name: 'no-such-skill' });
      expect(got.json.result).toBeUndefined();
      expect(got.json.error.code).toBe(unknown.json.error.code);
      expect(got.json.error.message.replace('house-style', 'X')).toBe(unknown.json.error.message.replace('no-such-skill', 'X'));
      expect(JSON.stringify(got.json)).not.toContain('utilize');
    });
  });

  describe('every write needs a control-plane admin', () => {
    const writes = [
      ['POST', '', { ...HOUSE_STYLE, slug: 'other' }],
      ['PATCH', '/house-style', { body: 'hijacked' }],
      ['POST', '/house-style/archive', undefined],
      ['POST', '/import', { documents: [{ content: '# x' }] }],
      ['POST', '/house-style/versions/1/restore', undefined],
      ['DELETE', '/house-style', undefined],
    ] as const;

    it('a non-admin member is refused by the guard and, without the guard, by the router', async () => {
      for (const [method, path, body] of writes) {
        const guarded = await request(`/api/v1/agent/skills${path}`, member, method, body);
        expect(guarded.status, `${method} ${path}`).toBe(403);
        const unguarded = await request(`/api/v1/unguarded/skills${path}`, member, method, body);
        expect(unguarded.status, `unguarded ${method} ${path}`).toBe(403);
        expect(unguarded.json.errors[0].code).toBe('FORBIDDEN');
      }
      const [row] = await db.select().from(siteSkills).where(eq(siteSkills.siteId, SITE));
      expect(row).toMatchObject({ status: 'active', body: HOUSE_STYLE.body, version: 1 });
    });

    it('a grant holding "skills:write" but not admin cannot write: there is no delegated writer', async () => {
      grantOverride.value = {
        allowed: true,
        capabilities: ['items:read', 'skills:write'],
        controlPlaneAdmin: false,
        callerClass: 'standard',
      };
      for (const [method, path, body] of writes) {
        const res = await request(`/api/v1/agent/skills${path}`, admin, method, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.json.errors[0].code).toBe('FORBIDDEN');
      }
      const rows = await db.select().from(siteSkills).where(eq(siteSkills.siteId, SITE));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'active', body: HOUSE_STYLE.body, version: 1 });
    });

    it('the admin can write', async () => {
      const res = await request('/api/v1/agent/skills/house-style', admin, 'PATCH', { body: 'Admin edit.' });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.data).toMatchObject({ version: 2, body: 'Admin edit.' });
    });
  });
});
