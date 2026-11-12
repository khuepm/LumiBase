/**
 * Migration plan (#728): map a source content model onto LumiBase
 * collections and fields, compared with what the site already has.
 *
 * The plan is additive and never destructive:
 * - a content type with no matching collection becomes a **new** collection
 *   (string primary key, so items keep their source ids and links resolve in
 *   one pass, and a re-run updates instead of duplicating);
 * - for an **existing** collection only missing fields are added; a field
 *   whose name exists with a different type is planned under a new name
 *   (`<name>_<source>`) and reported as a conflict. Existing fields are never
 *   changed or removed.
 */
import { RICHTEXT_INTERFACE } from '../richtext/index';
import type { SourceContentType, SourceExport, SourceField } from './types';

/** Structural item columns a data field may not shadow. */
const RESERVED_FIELDS = new Set(['id', 'status', 'sort', 'user_created', 'user_updated', 'created_at', 'updated_at']);
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

/** `blogPost` / `Blog-Post 2` → `blog_post` / `blog_post_2`. */
export function toSnakeName(raw: string): string {
  const snake = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const safe = /^[a-z]/.test(snake) ? snake : `f_${snake}`;
  return safe.slice(0, 63).replace(/_+$/, '') || 'field';
}

export interface ExistingField {
  name: string;
  type: string;
  interface?: string;
}

export interface ExistingCollection {
  name: string;
  fields: ExistingField[];
}

export interface MigrationPlanOptions {
  /** Prefix for new collection names, e.g. `cf_`. */
  collectionPrefix?: string;
  /** Source locale → LumiBase locale, e.g. `{ 'en-US': 'en' }`. Unmapped codes pass through. */
  localeMap?: Record<string, string>;
}

export interface PlannedField {
  /** Source field id. */
  source: string;
  name: string;
  type: string;
  interface: string;
  label: string;
  required: boolean;
  options?: Record<string, unknown>;
  note?: string;
  /** `existing` = already present with a compatible type; nothing to write. */
  action: 'create' | 'existing';
  /** How values are stored, used by the transform. */
  storage: FieldStorage;
  /** For `localeMap` / `translatable`: how each per-locale value is converted. */
  itemStorage?: FieldStorage;
}

export type FieldStorage = 'value' | 'localeMap' | 'translatable' | 'link' | 'links' | 'polyLink' | 'polyLinks' | 'file' | 'files' | 'geo';

export interface PlannedRelation {
  manyCollection: string;
  manyField: string;
  oneCollection: string;
  type: 'm2o';
}

export interface PlannedCollection {
  /** Source content type id. */
  source: string;
  name: string;
  label: string;
  action: 'create' | 'update';
  displayTemplate?: string;
  note?: string;
  fields: PlannedField[];
  relations: PlannedRelation[];
}

export interface MigrationPlan {
  source: SourceExport['source'];
  sourceId?: string;
  defaultLocale: { source: string; target: string };
  locales: Array<{ source: string; target: string }>;
  collections: PlannedCollection[];
  conflicts: string[];
  warnings: string[];
  counts: { contentTypes: number; fields: number; entries: number; assets: number };
}

const TEXT_TYPES = new Set(['string', 'text']);

function fieldShape(
  f: SourceField,
  target: (ct: string) => string | undefined,
): Pick<PlannedField, 'type' | 'interface' | 'options' | 'storage' | 'note'> {
  const localizedMap = (_type: string, iface: string): Pick<PlannedField, 'type' | 'interface' | 'storage' | 'note'> => ({
    type: 'json',
    interface: iface,
    storage: 'localeMap',
    note: `Localized ${f.sourceType}: stored as { locale: value }.`,
  });
  switch (f.kind) {
    case 'shortText':
      if (f.localized) return { type: 'json', interface: 'translatable-text', storage: 'translatable' };
      if (f.choices?.length) {
        return {
          type: 'string',
          interface: 'select-dropdown',
          options: { choices: f.choices.map((c) => ({ text: c, value: c })) },
          storage: 'value',
        };
      }
      return { type: 'string', interface: 'input', storage: 'value' };
    case 'longText':
      return f.localized
        ? { type: 'json', interface: 'translatable-text', storage: 'translatable' }
        : { type: 'text', interface: 'markdown', storage: 'value' };
    case 'richText':
      return f.localized
        ? { ...localizedMap('json', RICHTEXT_INTERFACE), note: 'Localized rich text: stored as { locale: document }.' }
        : { type: 'json', interface: RICHTEXT_INTERFACE, storage: 'value' };
    case 'integer':
      return f.localized ? localizedMap('json', 'json-raw') : { type: 'integer', interface: 'input-number', storage: 'value' };
    case 'number':
      return f.localized ? localizedMap('json', 'json-raw') : { type: 'decimal', interface: 'input-number', storage: 'value' };
    case 'boolean':
      return f.localized ? localizedMap('json', 'json-raw') : { type: 'boolean', interface: 'toggle', storage: 'value' };
    case 'date':
      return f.localized ? localizedMap('json', 'json-raw') : { type: 'datetime', interface: 'datetime', storage: 'value' };
    case 'location':
      return f.localized ? localizedMap('json', 'json-raw') : { type: 'geometry', interface: 'map', storage: 'geo' };
    case 'object':
      return f.localized ? localizedMap('json', 'json-raw') : { type: 'json', interface: 'json-raw', storage: 'value' };
    case 'shortTextList':
      return f.localized ? localizedMap('json', 'json-raw') : { type: 'json', interface: 'tags', storage: 'value' };
    case 'assetLink':
      return f.localized ? localizedMap('json', 'json-raw') : { type: 'string', interface: 'file', storage: 'file' };
    case 'assetLinks':
      return f.localized ? localizedMap('json', 'json-raw') : { type: 'json', interface: 'files', storage: 'files' };
    case 'entryLink': {
      const one = f.linkContentTypes?.length === 1 ? target(f.linkContentTypes[0]!) : undefined;
      if (f.localized) return localizedMap('json', 'json-raw');
      if (one) return { type: 'string', interface: 'relation-m2o', options: { collection: one }, storage: 'link' };
      return {
        type: 'json',
        interface: 'json-raw',
        storage: 'polyLink',
        note: 'Reference to more than one content type: stored as { collection, id }.',
      };
    }
    case 'entryLinks': {
      const one = f.linkContentTypes?.length === 1 ? target(f.linkContentTypes[0]!) : undefined;
      if (f.localized) return localizedMap('json', 'json-raw');
      return one
        ? { type: 'json', interface: 'json-raw', options: { collection: one }, storage: 'links', note: `List of ${one} ids.` }
        : { type: 'json', interface: 'json-raw', storage: 'polyLinks', note: 'List of { collection, id }.' };
    }
  }
}

/**
 * Build the plan. `existing` is the site's current schema (collections with
 * their fields); pass `[]` to plan against an empty site.
 */
export function buildMigrationPlan(
  source: SourceExport,
  existing: ExistingCollection[],
  opts: MigrationPlanOptions = {},
): MigrationPlan {
  const prefix = opts.collectionPrefix ?? '';
  const existingByName = new Map(existing.map((c) => [c.name, c]));
  const conflicts: string[] = [];
  const warnings = [...source.warnings];

  const nameFor = (ct: SourceContentType) => {
    let name = toSnakeName(`${prefix}${ct.id}`);
    if (name.startsWith('lumibase_') || name.startsWith('mat_')) name = toSnakeName(`cf_${name}`);
    return name;
  };
  const collectionName = new Map(source.contentTypes.map((ct) => [ct.id, nameFor(ct)]));
  const seen = new Set<string>();
  for (const [ct, name] of collectionName) {
    if (seen.has(name)) throw new Error(`Content types map to the same collection name "${name}" (${ct}); use a different prefix.`);
    seen.add(name);
  }

  const localeMap = opts.localeMap ?? {};
  const locales = source.locales.map((l) => ({ source: l.code, target: localeMap[l.code] ?? l.code }));
  const def = source.locales.find((l) => l.default) ?? source.locales[0]!;
  const defaultLocale = { source: def.code, target: localeMap[def.code] ?? def.code };

  const collections: PlannedCollection[] = source.contentTypes.map((ct) => {
    const name = collectionName.get(ct.id)!;
    const current = existingByName.get(name);
    const currentFields = new Map((current?.fields ?? []).map((f) => [f.name, f]));
    const used = new Set(currentFields.keys());
    const fields: PlannedField[] = [];
    const relations: PlannedRelation[] = [];

    for (const f of ct.fields) {
      const shape = fieldShape(f, (id) => collectionName.get(id));
      let fieldName = toSnakeName(f.id);
      if (RESERVED_FIELDS.has(fieldName)) fieldName = `${fieldName}_field`;
      let action: PlannedField['action'] = 'create';
      const have = currentFields.get(fieldName);
      if (have) {
        const compatible = have.type === shape.type || (TEXT_TYPES.has(have.type) && TEXT_TYPES.has(shape.type));
        if (compatible) action = 'existing';
        else {
          const renamed = toSnakeName(`${fieldName}_${source.source}`);
          conflicts.push(`${name}.${fieldName} exists as ${have.type}; ${ct.id}.${f.id} (${shape.type}) goes to ${renamed}.`);
          fieldName = renamed;
          if (currentFields.has(fieldName)) action = 'existing';
        }
      } else if (used.has(fieldName)) {
        fieldName = toSnakeName(`${fieldName}_2`);
      }
      if (!NAME_RE.test(fieldName)) throw new Error(`Cannot derive a valid field name from ${ct.id}.${f.id}.`);
      used.add(fieldName);
      const itemStorage = f.localized ? fieldShape({ ...f, localized: false }, (id) => collectionName.get(id)).storage : undefined;
      fields.push({
        source: f.id,
        name: fieldName,
        label: f.name,
        required: false,
        action,
        ...shape,
        ...(itemStorage ? { itemStorage } : {}),
        note: [shape.note, f.required ? 'Required in the source.' : undefined].filter(Boolean).join(' ') || undefined,
      });
      if (shape.storage === 'link' && action === 'create') {
        relations.push({ manyCollection: name, manyField: fieldName, oneCollection: String(shape.options?.collection), type: 'm2o' });
      }
      if (f.kind === 'entryLink' && f.linkContentTypes?.length === 1 && !collectionName.get(f.linkContentTypes[0]!)) {
        warnings.push(`${ct.id}.${f.id} links to content type ${f.linkContentTypes[0]} which is not in the export.`);
      }
    }

    const display = ct.displayField ? fields.find((p) => p.source === ct.displayField) : undefined;
    return {
      source: ct.id,
      name,
      label: ct.name,
      action: current ? 'update' : 'create',
      ...(display ? { displayTemplate: `{{${display.name}}}` } : {}),
      ...(ct.description ? { note: ct.description } : {}),
      fields,
      relations,
    };
  });

  for (const c of collections) {
    if (c.action === 'update') {
      warnings.push(
        `${c.name} already exists. Only missing fields are added. Items keep their source ids only if the collection uses a string primary key.`,
      );
    }
  }

  return {
    source: source.source,
    ...(source.sourceId ? { sourceId: source.sourceId } : {}),
    defaultLocale,
    locales,
    collections,
    conflicts,
    warnings,
    counts: {
      contentTypes: source.contentTypes.length,
      fields: collections.reduce((n, c) => n + c.fields.length, 0),
      entries: source.entries.length,
      assets: source.assets.length,
    },
  };
}

/** Human-readable dry-run report. */
export function formatMigrationPlan(plan: MigrationPlan): string {
  const lines: string[] = [];
  lines.push(
    `Source: ${plan.source}${plan.sourceId ? ` (${plan.sourceId})` : ''} · ${plan.counts.contentTypes} content types · ${plan.counts.entries} entries · ${plan.counts.assets} assets`,
  );
  lines.push(
    `Locales: ${plan.locales.map((l) => (l.source === l.target ? l.source : `${l.source} → ${l.target}`)).join(', ')} (default ${plan.defaultLocale.target})`,
  );
  for (const c of plan.collections) {
    lines.push('');
    lines.push(`${c.action === 'create' ? '+ create' : '~ update'} collection ${c.name}  (${c.source})`);
    for (const f of c.fields) {
      lines.push(`    ${f.action === 'create' ? '+' : '='} ${f.name}: ${f.type} [${f.interface}]${f.note ? `  — ${f.note}` : ''}`);
    }
    for (const r of c.relations) lines.push(`    + relation ${r.manyCollection}.${r.manyField} → ${r.oneCollection} (m2o)`);
  }
  if (plan.conflicts.length) {
    lines.push('', 'Conflicts:');
    for (const c of plan.conflicts) lines.push(`  ! ${c}`);
  }
  if (plan.warnings.length) {
    lines.push('', 'Warnings:');
    for (const w of plan.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}
