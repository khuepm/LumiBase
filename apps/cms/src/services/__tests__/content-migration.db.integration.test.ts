import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { collections, fields, relations, sites, type Database } from '@lumibase/database';
import { SchemaService } from '../schema-service';
import { applyContentMigrationSchema, planContentMigration, type ContentMigrationArgs } from '../content-migration-service';
import { CORE_SKILLS, isControlPlaneSkill } from '../ai-harness';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Agent skills for content migration (#728): plan against the live schema,
 * apply additively, and the apply skill always needs human approval.
 */

const SITE = 'site_content_migration_it';
const SPACE = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../packages/cli/test/fixtures/contentful-space.json'), 'utf8'),
) as { contentTypes: Array<Record<string, unknown>>; locales: Array<Record<string, unknown>> };
const ARGS: ContentMigrationArgs = { source: 'contentful', contentTypes: SPACE.contentTypes, locales: SPACE.locales, localeMap: { 'en-US': 'en' } };

describe('content migration skills', () => {
  it('apply is control-plane (parks for approval); plan is not', () => {
    expect(isControlPlaneSkill(CORE_SKILLS.applyContentMigrationSchema!, 'applyContentMigrationSchema')).toBe(true);
    expect(isControlPlaneSkill(CORE_SKILLS.planContentMigration!, 'planContentMigration')).toBe(false);
  });
});

describe.skipIf(!hasDbIntegrationUrl)('content migration skills — DB integration', () => {
  let db: Database;
  let schema: SchemaService;

  beforeAll(async () => {
    db = await connectDbIntegration('content-migration');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({
      organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`,
      id: SITE,
      name: 'Content migration IT',
    });
    schema = new SchemaService({ db, siteId: SITE });
  });

  it('plans against the current schema without writing', async () => {
    const { plan, report } = await planContentMigration(ARGS, schema);
    expect(plan.collections.map((c) => [c.name, c.action])).toEqual([
      ['author', 'create'],
      ['category', 'create'],
      ['blog_post', 'create'],
      ['product', 'create'],
      ['page', 'create'],
    ]);
    expect(report).toContain('+ create collection blog_post');
    expect(report).not.toContain('0 entries');
    expect(await db.select().from(collections).where(eq(collections.siteId, SITE))).toHaveLength(0);
  });

  it('creates collections with string ids, fields and relations; a second apply changes nothing', async () => {
    const first = await applyContentMigrationSchema(ARGS, schema);
    expect(first.created.collections).toEqual(['author', 'category', 'blog_post', 'product', 'page']);
    expect(first.created.relations).toEqual(['blog_post.author']);
    const post = (await db.select().from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'blog_post'))))[0]!;
    expect(post.primaryKeyType).toBe('string');
    const postFields = await db.select().from(fields).where(eq(fields.collectionId, post.id));
    expect(postFields.find((f) => f.name === 'body')).toMatchObject({ type: 'json', interface: 'richtext' });
    expect(await db.select().from(relations).where(eq(relations.siteId, SITE))).toHaveLength(1);

    const second = await applyContentMigrationSchema(ARGS, schema);
    expect(second.created).toEqual({ collections: [], fields: [], relations: [] });
    expect(second.plan.collections.every((c) => c.action === 'update')).toBe(true);
  });
});
