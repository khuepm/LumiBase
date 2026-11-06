import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  agentApprovals,
  agentRuns,
  agentToolCalls,
  agentTools,
  aiApprovals,
  collections,
  contentVersions,
  fields,
  items,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AISecureHarness, CORE_SKILLS } from '../ai-harness';
import { ToolRegistryService } from '../tool-registry-service';
import { EffectiveCapabilityService } from '../effective-capability-service';
import { itemServiceForPrincipal } from '../item-service-factory';
import { SchemaService } from '../schema-service';

/**
 * Tool contract parity on the path production uses (#585).
 *
 * ## What was wrong (measured at 7a9fdea7, before the fix)
 *
 * F1. Seven skills that write had no canonical schema in `AgentToolSchemas`:
 *     the four version skills, `repairTranslation`, `triggerDeployment`, and
 *     `replayCdcSubscription` had one that left `occurredAfter` optional
 *     although the handler cannot run without it. Validation is fail-open for a
 *     skill without a schema, so `tools/list` advertised a required list that
 *     the harness never checked. A dangerous skill called with `{}` parked an
 *     approval for input that can never execute (the GP5 class of #454), and a
 *     non-dangerous one (`repairTranslation`) ran into the handler and left a
 *     failed run behind. `triggerDeployment` also read a caller-supplied
 *     `__runId` into the deployment's `triggeredBy`.
 *
 * F2. An `agent_tools` row replaced a core skill's `requiredCapabilities`. A row
 *     with `[]` removed the capability check, and since `evaluateRisk` reads the
 *     same list, a row on `createCollection` (dangerous only through
 *     `schema:create`) also turned off HITL: the collection was created directly.
 *
 * ## Evidence class
 *
 * REAL PostgreSQL, real `SchemaService` and a real `ItemService` bound to a
 * resolved principal. Assertions read the rows back. No network, no LLM.
 */
const SITE = 'site_585_parity';
const ADMIN = 'usr_585_admin';
const ADMIN_ROLE = 'role_585_admin';
const AGENT = 'audit-585-agent';

describe.skipIf(!hasDbIntegrationUrl)('#585 tool contract parity — DB integration', () => {
  let db: Database;
  let itemId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('tool-contract-parity');
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, ADMIN)).catch(() => undefined);
  });
  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(users).where(eq(users.id, ADMIN));
    await db.insert(sites).values({ id: SITE, name: '585 parity' });
    await db.insert(users).values({ id: ADMIN, email: 'audit-585-admin@example.dev' });
    await db.insert(roles).values({ id: ADMIN_ROLE, siteId: SITE, name: '585 Administrator', adminAccess: true, appAccess: true });
    await db.insert(userSites).values({ userId: ADMIN, siteId: SITE, roleId: ADMIN_ROLE });
    const [collection] = await db.insert(collections).values({ siteId: SITE, name: 'posts', label: 'Posts' }).returning();
    await db.insert(fields).values({ siteId: SITE, collectionId: collection!.id, name: 'title', type: 'string', interface: 'input' });
    const [item] = await db
      .insert(items)
      .values({ siteId: SITE, collectionId: collection!.id, status: 'draft', data: { title: 'v1' } })
      .returning();
    itemId = item!.id;
  }, 30_000);

  const adminRef = { type: 'user' as const, siteId: SITE, userId: ADMIN };

  async function harness() {
    const grant = await new EffectiveCapabilityService({ db, siteId: SITE }).resolve(adminRef);
    expect(grant.allowed, 'fixture principal must resolve').toBe(true);
    const allowed = grant as Extract<typeof grant, { allowed: true }>;
    return new AISecureHarness({
      db,
      siteId: SITE,
      schemaService: new SchemaService({ db, siteId: SITE }),
      itemService: itemServiceForPrincipal({ db, siteId: SITE, userId: ADMIN }, allowed.permissionContext!),
      enableAgentHarnessAudit: true,
    });
  }
  const envelope = () => ({
    agentName: AGENT,
    requestedByPrincipal: { kind: 'principal', ref: adminRef } as never,
  });

  async function persisted() {
    const count = async (table: typeof agentRuns | typeof agentToolCalls | typeof aiApprovals | typeof agentApprovals | typeof contentVersions) =>
      (await db.select({ id: table.id }).from(table).where(eq(table.siteId, SITE))).length;
    return {
      runs: await count(agentRuns),
      toolCalls: await count(agentToolCalls),
      aiApprovals: await count(aiApprovals),
      agentApprovals: await count(agentApprovals),
      versions: await count(contentVersions),
    };
  }
  const NOTHING = { runs: 0, toolCalls: 0, aiApprovals: 0, agentApprovals: 0, versions: 0 };

  describe('F1: every write-capable skill is validated before anything is persisted', () => {
    const cases: Array<[string, (id: string) => Record<string, unknown>, string]> = [
      ['createVersion', () => ({}), 'collection'],
      ['createVersion', (id) => ({ collection: 'posts', itemId: id, key: 'v1' }), 'name'],
      ['updateVersion', (id) => ({ collection: 'posts', itemId: id, key: 'v1', data: 'not-an-object' }), 'data'],
      ['deleteVersion', () => ({}), 'collection'],
      ['promoteVersion', (id) => ({ collection: 'posts', itemId: id }), 'key'],
      ['repairTranslation', () => ({}), 'collection'],
      ['triggerDeployment', () => ({}), 'targetId'],
      ['triggerDeployment', () => ({ targetId: 'tgt_1', __runId: 'run_spoofed' }), '__runId'],
      ['replayCdcSubscription', () => ({ subscriptionId: 'sub_1' }), 'occurredAfter'],
      ['replayCdcSubscription', () => ({ subscriptionId: 'sub_1', occurredAfter: 'yesterday' }), 'occurredAfter'],
    ];
    for (const [skill, args, field] of cases) {
      it(`${skill} ${JSON.stringify(args('<item>'))} → VALIDATION naming ${field}, zero rows`, async () => {
        const result = await (await harness()).execute(skill, args(itemId), ['*'], `#585 ${skill}`, envelope());
        expect(result.status, JSON.stringify(result)).toBe('denied');
        expect(result.code).toBe('VALIDATION');
        expect(result.message).toContain(field);
        expect(await persisted()).toEqual(NOTHING);
      });
    }

    it('control: valid createVersion input still parks one approval and writes no version', async () => {
      const result = await (await harness()).execute(
        'createVersion',
        { collection: 'posts', itemId, key: 'v1', name: 'Version 1' },
        ['*'],
        '#585 control',
        envelope(),
      );
      expect(result.status, JSON.stringify(result)).toBe('pending_approval');
      const rows = await persisted();
      expect(rows.agentApprovals).toBe(1);
      expect(rows.versions).toBe(0);
    });
  });

  describe('F2: an agent_tools row cannot drop a core skill’s capabilities', () => {
    async function overrideCreateCollection() {
      await db.insert(agentTools).values({
        siteId: SITE,
        name: 'createCollection',
        description: 'site override',
        requiredCapabilities: [],
        riskPolicy: { level: 'safe' },
        owner: 'db',
      });
    }
    async function collectionExists(name: string) {
      const rows = await db
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.siteId, SITE), eq(collections.name, name)));
      return rows.length > 0;
    }

    it('a caller without schema:create is refused', async () => {
      await overrideCreateCollection();
      const registry = new ToolRegistryService(db, SITE, CORE_SKILLS);
      expect((await registry.getTool('createCollection'))?.riskPolicy.level).toBe('dangerous');
      expect((await registry.listTools()).find((t) => t.name === 'createCollection')?.riskPolicy.level).toBe('dangerous');
      const result = await (await harness()).execute('createCollection', { name: 'f2_nocap' }, [], '#585 F2', envelope());
      expect(result.status, JSON.stringify(result)).toBe('denied');
      expect(result.message).toBe('Insufficient capabilities');
      expect(await collectionExists('f2_nocap')).toBe(false);
    });

    it('the schema write keeps its approval step', async () => {
      await overrideCreateCollection();
      const registry = new ToolRegistryService(db, SITE, CORE_SKILLS);
      expect((await registry.getTool('createCollection'))?.riskPolicy.level).toBe('dangerous');
      expect((await registry.listTools()).find((t) => t.name === 'createCollection')?.riskPolicy.level).toBe('dangerous');
      const result = await (await harness()).execute(
        'createCollection',
        { name: 'f2_hitl' },
        ['schema:create'],
        '#585 F2',
        envelope(),
      );
      expect(result.status, JSON.stringify(result)).toBe('pending_approval');
      expect(await collectionExists('f2_hitl')).toBe(false);
    });

    it('an override may still add a capability (narrowing stays allowed)', async () => {
      await db.insert(agentTools).values({
        siteId: SITE,
        name: 'listCollections',
        description: 'site override',
        requiredCapabilities: ['audit:read'],
        owner: 'db',
      });
      const denied = await (await harness()).execute('listCollections', {}, ['schema:read'], '#585 F2', envelope());
      expect(denied.status).toBe('denied');
      const allowed = await (await harness()).execute(
        'listCollections',
        {},
        ['schema:read', 'audit:read'],
        '#585 F2',
        envelope(),
      );
      expect(allowed.status, JSON.stringify(allowed)).toBe('executed');
    });
  });
});
