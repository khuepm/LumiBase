import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  agentApprovals,
  agentAutonomyGrants,
  roles,
  siteSkills,
  siteSkillVersions,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AISecureHarness } from '../ai-harness';
import { SchemaService } from '../schema-service';
import type { ApprovalDecider } from '../external-action-audit';

/**
 * An agent proposing a Site Skill (#712, B201) against REAL PostgreSQL.
 *
 * Pinned: a proposal never writes a skill by itself (it parks for approval at
 * every autonomy level below autopilot); an approved proposal creates a DRAFT,
 * never an active skill; the version trail names the agent and its rationale;
 * everything is site-scoped.
 */

const SITE = 'site_b201_a';
const OTHER = 'site_b201_b';
const ADMIN = 'usr_b201_admin';
const ADMIN_ROLE = 'role_b201_admin';
const AGENT = 'b201-agent';
const HUMAN: ApprovalDecider = { kind: 'human', userId: ADMIN };

const PROPOSAL = {
  slug: 'house-style',
  name: 'House style',
  description: 'Voice and tone',
  body: '# House style\n\nWrite in sentence case. Never use exclamation marks.',
  surfaces: ['generation'],
  rationale: 'Editors corrected title case in 12 of the last 20 drafts.',
};

describe.skipIf(!hasDbIntegrationUrl)('proposeSiteSkill (B201) — DB integration', () => {
  let db: Database;

  const harness = (siteId = SITE) =>
    new AISecureHarness({ db, siteId, schemaService: new SchemaService({ db, siteId }), enableAgentHarnessAudit: true });

  const propose = (args: Record<string, unknown> = PROPOSAL, siteId = SITE) =>
    harness(siteId).execute('proposeSiteSkill', args, ['admin'], 'propose a playbook', {
      agentName: AGENT,
      requestedByPrincipal: { kind: 'principal', ref: { type: 'user', siteId, userId: ADMIN } },
    });

  beforeAll(async () => {
    db = await connectDbIntegration('propose-site-skill');
  });
  const cleanup = async () => {
    await db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER})`);
    await db.delete(users).where(eq(users.id, ADMIN));
  };
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });
  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE, name: 'B201 A' },
      { organizationId: org, id: OTHER, name: 'B201 B' },
    ]);
    await db.insert(users).values({ id: ADMIN, email: 'b201-admin@example.dev' });
    await db.insert(roles).values({ id: ADMIN_ROLE, siteId: SITE, name: 'B201 Admin', adminAccess: true, appAccess: true });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE });
  });

  async function setLevel(level: number) {
    await db.delete(agentAutonomyGrants).where(eq(agentAutonomyGrants.siteId, SITE));
    await db.insert(agentAutonomyGrants).values({ siteId: SITE, agentRole: AGENT, capability: 'config:write', level });
  }

  it('parks for approval below autopilot and writes nothing until a human approves', async () => {
    for (const level of [1, 2, 3]) {
      await setLevel(level);
      const result = await propose();
      expect(result.status, `L${level}`).toBe('pending_approval');
    }
    expect(await db.select().from(siteSkills).where(eq(siteSkills.siteId, SITE))).toEqual([]);
  });

  it('an approved proposal creates a draft with the agent and its rationale on the version trail', async () => {
    await setLevel(2);
    const parked = await propose();
    expect(parked.status).toBe('pending_approval');
    const approved = await harness().executeApproved(parked.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(approved.status).toBe('executed');
    expect(approved.data).toMatchObject({ proposed: true, status: 'draft', skill: { slug: 'house-style', version: 1 } });

    const [skill] = await db.select().from(siteSkills).where(and(eq(siteSkills.siteId, SITE), eq(siteSkills.slug, 'house-style')));
    expect(skill).toMatchObject({ status: 'draft', name: 'House style', surfaces: ['generation'] });
    const [version] = await db.select().from(siteSkillVersions).where(eq(siteSkillVersions.skillId, skill!.id));
    expect(version).toMatchObject({ authorId: null, authorLabel: 'agent:proposeSiteSkill' });
    expect(version!.changeNote).toContain('Editors corrected title case');
    const [decided] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, parked.agentApprovalId!));
    expect(decided).toMatchObject({ status: 'approved', siteId: SITE });

    // A second proposal with the same slug cannot overwrite it.
    const again = await propose();
    const second = await harness().executeApproved(again.approvalId!, ADMIN, ['admin'], HUMAN);
    expect(second.status).not.toBe('executed');
    expect(await db.select().from(siteSkills).where(eq(siteSkills.siteId, SITE))).toHaveLength(1);
    expect(await db.select().from(siteSkills).where(eq(siteSkills.siteId, OTHER))).toEqual([]);
  });

  it('refuses an invalid proposal before anything is parked', async () => {
    for (const bad of [
      { ...PROPOSAL, slug: 'House Style' },
      { ...PROPOSAL, rationale: undefined },
      { ...PROPOSAL, body: 'x'.repeat(12_001) },
      { ...PROPOSAL, extra: true },
      { ...PROPOSAL, slug: 'import' },
    ]) {
      const result = await propose(bad as Record<string, unknown>);
      expect(result, JSON.stringify(Object.keys(bad))).toMatchObject({ status: 'denied', code: 'VALIDATION' });
    }
    expect(await db.select().from(agentApprovals).where(eq(agentApprovals.siteId, SITE))).toEqual([]);
  });

  it('needs config:write', async () => {
    const result = await harness().execute('proposeSiteSkill', PROPOSAL, ['items:write'], undefined, {
      agentName: AGENT,
      requestedByPrincipal: { kind: 'principal', ref: { type: 'user', siteId: SITE, userId: ADMIN } },
    });
    expect(result).toMatchObject({ status: 'denied', message: 'Insufficient capabilities' });
  });
});
