import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { agentTools, collections, fields, items, sites, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AISecureHarness, skillCatalog } from '../ai-harness';
import { ItemService } from '../item-service';
import { SchemaService } from '../schema-service';
import { ToolRegistryService, isEnforceableOverrideSchema } from '../tool-registry-service';

/**
 * Per-site `agent_tools` schema overrides (B205, #716) against REAL PostgreSQL.
 *
 * Before: an override that narrowed a core tool was advertised on that site's
 * `tools/list` but never enforced (the harness validated only the canonical
 * Zod), and an override was never checked to be a valid JSON Schema, so one
 * row could advertise an invalid schema. Now an override is advertised only
 * when it is well formed and narrowing, and then it is enforced.
 */

const SITE = 'site_b205_override';
const OTHER = 'site_b205_other';

describe.skipIf(!hasDbIntegrationUrl)('agent_tools schema overrides (B205) — DB integration', () => {
  let db: Database;

  const harness = (siteId = SITE) =>
    new AISecureHarness({
      db,
      siteId,
      schemaService: new SchemaService({ db, siteId }),
      itemService: new ItemService({ db, siteId }),
      enableAgentHarnessAudit: true,
    });

  beforeAll(async () => {
    db = await connectDbIntegration('tool-override-schema');
  });
  const cleanup = () => db.delete(sites).where(sql`${sites.id} IN (${SITE}, ${OTHER})`);
  afterAll(async () => {
    if (db) await cleanup().catch(() => undefined);
  });
  beforeEach(async () => {
    await cleanup();
    const org = sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`;
    await db.insert(sites).values([
      { organizationId: org, id: SITE, name: 'B205' },
      { organizationId: org, id: OTHER, name: 'B205 other' },
    ]);
    for (const siteId of [SITE, OTHER]) {
      const [collection] = await db.insert(collections).values({ siteId, name: 'posts' }).returning();
      await db.insert(fields).values({ siteId, collectionId: collection!.id, name: 'title', type: 'string', interface: 'input' });
      await db.insert(items).values({ id: `${siteId}_p1`, siteId, collectionId: collection!.id, data: { title: 'hi' } });
    }
  });

  async function override(inputSchema: unknown, siteId = SITE) {
    await db.insert(agentTools).values({ siteId, name: 'listItems', description: 'List items (site override)', inputSchema });
  }

  const call = (args: Record<string, unknown>, siteId = SITE) =>
    harness(siteId).execute('listItems', args, ['items:read'], undefined, { agentName: 'b205-agent' });

  it('advertises and enforces a narrowing override, only on its own site', async () => {
    const narrowed = {
      type: 'object',
      properties: { collection: { type: 'string' }, limit: { type: 'integer', maximum: 10 } },
      required: ['collection', 'limit'],
    };
    await override(narrowed);

    const listed = (await new ToolRegistryService(db, SITE, skillCatalog()).listTools()).find((t) => t.name === 'listItems')!;
    expect(listed.inputSchema).toEqual(narrowed);
    expect(listed.enforcedOverrideSchema).toEqual(narrowed);

    // Missing the key the override requires (the canonical contract does not).
    expect(await call({ collection: 'posts' })).toMatchObject({ status: 'denied', code: 'VALIDATION' });
    // Above the override's bound.
    expect(await call({ collection: 'posts', limit: 50 })).toMatchObject({ status: 'denied', code: 'VALIDATION' });
    // Dropped property (`offset`) is refused.
    expect(await call({ collection: 'posts', limit: 5, offset: 0 })).toMatchObject({ status: 'denied', code: 'VALIDATION' });
    expect(await call({ collection: 'posts', limit: 5 })).toMatchObject({ status: 'executed' });

    // The other site has no override: canonical contract only.
    const other = (await new ToolRegistryService(db, OTHER, skillCatalog()).listTools()).find((t) => t.name === 'listItems')!;
    expect(other.enforcedOverrideSchema).toBeUndefined();
    expect(await call({ collection: 'posts' }, OTHER)).toMatchObject({ status: 'executed' });
  });

  it('never advertises an invalid override: the canonical schema stays', async () => {
    await override({ type: 'object', properties: { collection: { type: 'text' } }, required: ['collection'] });
    const registry = new ToolRegistryService(db, SITE, skillCatalog());
    const listed = (await registry.listTools()).find((t) => t.name === 'listItems')!;
    expect(listed.enforcedOverrideSchema).toBeUndefined();
    expect((listed.inputSchema['properties'] as Record<string, unknown>)['collection']).toMatchObject({ type: 'string' });
    expect(registry.rejectedOverrides).toContain('listItems');
    expect(await call({ collection: 'posts' })).toMatchObject({ status: 'executed' });
  });

  it('a broadening override is still refused', async () => {
    await override({ type: 'object', properties: { collection: { type: 'string' }, extra: { type: 'string' } }, required: ['collection'] });
    const listed = (await new ToolRegistryService(db, SITE, skillCatalog()).listTools()).find((t) => t.name === 'listItems')!;
    expect(listed.enforcedOverrideSchema).toBeUndefined();
    expect(await call({ collection: 'posts', extra: 'x' })).toMatchObject({ status: 'denied', code: 'VALIDATION' });
  });

  it('isEnforceableOverrideSchema accepts the JSON Schema subset the harness enforces', () => {
    expect(isEnforceableOverrideSchema({ type: 'object', properties: { a: { type: ['string', 'null'] } }, required: ['a'] })).toBe(true);
    expect(isEnforceableOverrideSchema({ type: 'object' })).toBe(true);
    for (const bad of [
      null,
      [],
      { type: 'array' },
      { type: 'object', properties: [] },
      { type: 'object', properties: { a: 'string' } },
      { type: 'object', properties: { a: { type: [] } } },
      { type: 'object', properties: { a: { enum: 'x' } } },
      { type: 'object', properties: { a: { maximum: '10' } } },
      { type: 'object', properties: { a: {} }, required: ['b'] },
    ]) {
      expect(isEnforceableOverrideSchema(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
