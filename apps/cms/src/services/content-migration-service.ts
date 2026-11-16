/**
 * Server side of content migrations (#728), used by the agent skills
 * `planContentMigration` and `applyContentMigrationSchema`.
 *
 * The mapping is the same code the `lumibase migrate` CLI runs
 * (`@lumibase/contracts/migrate`). Agents only plan and create the schema;
 * entries and assets are imported by the CLI. Applying the schema is a
 * control-plane write, so the harness parks it for human approval.
 */
import {
  buildMigrationPlan,
  formatMigrationPlan,
  parseContentfulExport,
  type ExistingCollection,
  type MigrationPlan,
} from '@lumibase/contracts/migrate';
import type { SchemaService } from './schema-service';

export interface ContentMigrationArgs {
  source: 'contentful';
  contentTypes: Array<Record<string, unknown>>;
  locales?: Array<Record<string, unknown>>;
  collectionPrefix?: string;
  localeMap?: Record<string, string>;
}

type SchemaReader = Pick<SchemaService, 'listCollections' | 'getCompiled'>;
type SchemaWriter = SchemaReader & Pick<SchemaService, 'createCollection' | 'upsertField' | 'createRelation'>;

/** Plan the migration against the site's current schema. */
export async function planContentMigration(
  args: ContentMigrationArgs,
  schema: SchemaReader,
): Promise<{ plan: MigrationPlan; report: string }> {
  const exported = parseContentfulExport({ contentTypes: args.contentTypes, locales: args.locales ?? [], entries: [], assets: [] });
  const opts = { collectionPrefix: args.collectionPrefix, localeMap: args.localeMap };
  const draft = buildMigrationPlan(exported, [], opts);
  const names = new Set(((await schema.listCollections()) as Array<{ name: string }>).map((c) => c.name));
  const existing: ExistingCollection[] = [];
  for (const c of draft.collections) {
    if (!names.has(c.name)) continue;
    const compiled = await schema.getCompiled(c.name);
    if (compiled) existing.push({ name: c.name, fields: compiled.fields.map((f) => ({ name: f.name, type: f.type, interface: f.interface })) });
  }
  const plan = buildMigrationPlan(exported, existing, opts);
  // Entries/assets are not part of the agent input; don't report them as 0.
  return { plan, report: formatMigrationPlan(plan).replace(/ · 0 entries · 0 assets/, '') };
}

/**
 * Create what the plan needs: new collections (string primary key, so the CLI
 * can import entries with their source ids), missing fields, then relations.
 * Never changes or removes an existing field.
 */
export async function applyContentMigrationSchema(
  args: ContentMigrationArgs,
  schema: SchemaWriter,
): Promise<{ plan: MigrationPlan; created: { collections: string[]; fields: string[]; relations: string[] } }> {
  const { plan } = await planContentMigration(args, schema);
  const created = { collections: [] as string[], fields: [] as string[], relations: [] as string[] };
  for (const c of plan.collections) {
    if (c.action === 'create') {
      await schema.createCollection({
        name: c.name,
        label: c.label,
        primaryKeyField: 'id',
        primaryKeyType: 'string',
        ...(c.displayTemplate ? { displayTemplate: c.displayTemplate } : {}),
        ...(c.note ? { note: c.note } : {}),
      } as never);
      created.collections.push(c.name);
    }
    for (const f of c.fields.filter((x) => x.action === 'create')) {
      await schema.upsertField(c.name, {
        name: f.name,
        type: f.type,
        interface: f.interface,
        label: f.label,
        required: f.required,
        ...(f.options ? { options: f.options } : {}),
        ...(f.note ? { note: f.note } : {}),
      } as never);
      created.fields.push(`${c.name}.${f.name}`);
    }
  }
  for (const c of plan.collections) {
    for (const r of c.relations) {
      await schema.createRelation(r as never);
      created.relations.push(`${r.manyCollection}.${r.manyField}`);
    }
  }
  return { plan, created };
}
