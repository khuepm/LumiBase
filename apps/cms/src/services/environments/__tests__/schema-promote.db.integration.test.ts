import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, collections, environmentLineage, environments, fields, items, type Database } from '@lumibase/database';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { ItemService } from '../../item-service';
import { SchemaService } from '../../schema-service';
import { envHarness, keyProvider } from './helpers';

/**
 * Schema_Promote on real Postgres (#853 task 6, gate GC): rows matched by
 * lineage, rename promoted as a rename (origin data kept), risky changes need
 * confirmation and a plan, conflicts block until resolved, dry-run writes
 * nothing, two promotes cannot run at once.
 */

const ORIGIN = 'site_env_schema_origin';
const ADMIN = 'usr_env_schema_admin';

type Plan = { entries: Array<{ kind: string; key: string; action: string; renameFrom?: string; reason?: string }>; clean: boolean; pendingCollections: string[] };

describe.skipIf(!hasDbIntegrationUrl)('Content Environments — schema promote (DB integration)', () => {
  let db: Database;
  const h = envHarness(() => db, ORIGIN, ADMIN);
  const originSchema = () => new SchemaService({ db, siteId: ORIGIN });
  const schemaOf = async (siteId: string) =>
    (await db.select().from(fields).where(eq(fields.siteId, siteId))).map((f) => ({ name: f.name, type: f.type, label: f.label })).sort((a, b) => a.name.localeCompare(b.name));

  beforeAll(async () => {
    db = await connectDbIntegration('environments-schema-promote');
  });
  afterAll(async () => {
    if (db) await h.cleanup();
  });
  beforeEach(async () => {
    await h.reset();
    await originSchema().createCollection({ name: 'posts', label: 'Posts' });
    await originSchema().createField('posts', { name: 'title', type: 'string', interface: 'input', label: 'Title' });
    await originSchema().createField('posts', { name: 'summary', type: 'string', interface: 'input', label: 'Summary' });
    await originSchema().createField('posts', { name: 'rating', type: 'string', interface: 'input' });
    await new ItemService({ db, siteId: ORIGIN, keyProvider }).create('posts', { data: { title: 'A', summary: 'old summary', rating: '4' } });
  });

  const promote = (key: string, body: Record<string, unknown>) => h.call('POST', `/environments/${key}/promote/schema`, body);

  it('a field added in the environment is created in the origin; dry-run writes nothing', async () => {
    const env = await h.fork('add');
    await new SchemaService({ db, siteId: env.siteId }).createField('posts', { name: 'subtitle', type: 'string', interface: 'input' });

    const before = await schemaOf(ORIGIN);
    const dry = await promote('add', { dryRun: true });
    expect(dry.status).toBe(200);
    const plan = (dry.json.data as { plan: Plan }).plan;
    expect(plan.entries.filter((e) => e.action !== 'unchanged')).toEqual([expect.objectContaining({ kind: 'field', key: 'posts.subtitle', action: 'create' })]);
    expect(plan.pendingCollections).toEqual(['posts']);
    expect(await schemaOf(ORIGIN)).toEqual(before);

    const apply = await promote('add', { dryRun: false });
    expect(apply.status).toBe(200);
    expect((await schemaOf(ORIGIN)).map((f) => f.name)).toContain('subtitle');
    const again = await promote('add', { dryRun: true });
    expect((again.json.data as { plan: Plan }).plan.clean).toBe(true);

    // Lineage now maps the new field; merge run and audit recorded.
    const lin = await db.select().from(environmentLineage).where(and(eq(environmentLineage.environmentId, env.id), eq(environmentLineage.kind, 'field')));
    expect(lin).toHaveLength(4);
    expect(lin.every((l) => l.originRowId)).toBe(true);
    const runs = await h.call('GET', '/environments/add/merge-runs');
    expect((runs.json.data as Array<{ kind: string; status: string }>)[0]).toMatchObject({ kind: 'schema', status: 'succeeded' });
    expect((await db.select().from(auditLog).where(and(eq(auditLog.siteId, ORIGIN), eq(auditLog.event, 'environment_schema_promoted')))).length).toBe(1);
    const [row] = await db.select().from(environments).where(eq(environments.id, env.id));
    expect(row!.status).toBe('ready');
  });

  it('a rename is promoted as a rename and the origin keeps its data under the new name', async () => {
    const env = await h.fork('rename');
    await new SchemaService({ db, siteId: env.siteId }).renameField('posts', 'summary', { name: 'excerpt', type: 'string', interface: 'input', label: 'Excerpt', confirmRiskyChange: true });

    const dry = await promote('rename', { dryRun: true });
    const entry = (dry.json.data as { plan: Plan }).plan.entries.find((e) => e.key === 'posts.excerpt');
    expect(entry).toMatchObject({ action: 'rename', renameFrom: 'summary' });

    const unconfirmed = await promote('rename', { dryRun: false });
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.json.errors![0]!.code).toBe('RISKY_CHANGE_UNCONFIRMED');
    expect((await schemaOf(ORIGIN)).map((f) => f.name)).toContain('summary');

    const ok = await promote('rename', { dryRun: false, confirmRiskyChange: true });
    expect(ok.status).toBe(200);
    const names = (await schemaOf(ORIGIN)).map((f) => f.name);
    expect(names).toContain('excerpt');
    expect(names).not.toContain('summary');
    const [item] = await db.select().from(items).where(eq(items.siteId, ORIGIN));
    expect(item!.data).toMatchObject({ title: 'A', excerpt: 'old summary' });
    expect(item!.data).not.toHaveProperty('summary');
  });

  it('a type change needs a migration plan; it applies to items created after the fork', async () => {
    const env = await h.fork('type');
    await new ItemService({ db, siteId: ORIGIN, keyProvider }).create('posts', { data: { title: 'after fork', rating: '5' } });
    await new SchemaService({ db, siteId: env.siteId }).updateField('posts', 'rating', { type: 'integer', interface: 'input', confirmRiskyChange: true });

    const noPlan = await promote('type', { dryRun: false, confirmRiskyChange: true });
    expect(noPlan.status).toBe(422);
    expect(noPlan.json.errors![0]!.code).toBe('MIGRATION_PLAN_REQUIRED');

    const ok = await promote('type', { dryRun: false, confirmRiskyChange: true, migrationPlans: { 'posts.rating': { strategy: 'cast-integer' } } });
    expect(ok.status).toBe(200);
    expect((await schemaOf(ORIGIN)).find((f) => f.name === 'rating')!.type).toBe('integer');
    // The origin collection applies the new type to every item, old or new.
    const compiled = await originSchema().getCompiled('posts');
    expect(compiled!.fields.find((f) => f.name === 'rating')!.type).toBe('integer');
  });

  it('a field changed in both sites is a conflict; apply refuses until resolved', async () => {
    const env = await h.fork('conflict');
    await new SchemaService({ db, siteId: env.siteId }).updateField('posts', 'title', { label: 'Headline (env)' });
    await originSchema().updateField('posts', 'title', { label: 'Heading (origin)' });

    const dry = await promote('conflict', { dryRun: true });
    expect((dry.json.data as { plan: Plan }).plan.entries.find((e) => e.key === 'posts.title')).toMatchObject({ action: 'conflict', reason: 'CHANGED_IN_BOTH' });

    const refused = await promote('conflict', { dryRun: false });
    expect(refused.status).toBe(422);
    expect(refused.json.errors![0]!.code).toBe('UNRESOLVED_CONFLICTS');
    expect((await schemaOf(ORIGIN)).find((f) => f.name === 'title')!.label).toBe('Heading (origin)');

    const keepOrigin = await promote('conflict', { dryRun: false, resolutions: [{ kind: 'field', key: 'posts.title', take: 'origin' }] });
    expect(keepOrigin.status).toBe(200);
    expect((await schemaOf(ORIGIN)).find((f) => f.name === 'title')!.label).toBe('Heading (origin)');

    const takeEnv = await promote('conflict', { dryRun: false, confirmRiskyChange: true, resolutions: [{ kind: 'field', key: 'posts.title', take: 'environment' }] });
    expect(takeEnv.status).toBe(200);
    expect((await schemaOf(ORIGIN)).find((f) => f.name === 'title')!.label).toBe('Headline (env)');
  });

  it('a second promote while one is running is ENVIRONMENT_BUSY', async () => {
    const env = await h.fork('busy-a');
    const other = await h.fork('busy-b');
    await db.update(environments).set({ status: 'merging', updatedAt: new Date() }).where(eq(environments.id, env.id));
    const res = await promote('busy-b', { dryRun: false });
    expect(res.status).toBe(409);
    expect(res.json.errors![0]!.code).toBe('ENVIRONMENT_BUSY');
    // Deleting a merging environment is refused too.
    expect((await h.call('DELETE', '/environments/busy-a')).status).toBe(409);
    void other;
    const [coll] = await db.select().from(collections).where(eq(collections.siteId, ORIGIN));
    expect(coll!.name).toBe('posts');
  });
});
