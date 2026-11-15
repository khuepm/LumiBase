import type { CompiledCollection, CompiledField } from '../schema-service';

/** Minimal compiled field factory for dynamic-zone (#748) tests. */
export function cf(name: string, type: string, extra: Partial<CompiledField> = {}): CompiledField {
  return {
    id: `f-${name}`,
    name,
    type,
    interface: type === 'blocks' ? 'blocks' : 'input',
    display: null,
    label: null,
    note: null,
    defaultValue: null,
    nullable: true,
    unique: false,
    indexed: false,
    searchable: false,
    length: null,
    precision: null,
    scale: null,
    special: [],
    translations: {},
    options: {},
    displayOptions: {},
    validation: { rules: [] },
    conditions: [],
    required: false,
    readonly: false,
    hidden: false,
    encrypted: false,
    classification: 'none',
    versioned: false,
    rawEnabled: false,
    width: 'full',
    group: null,
    sortOrder: 0,
    ...extra,
  };
}

export function blocksField(
  name: string,
  allowedBlocks: string[],
  extra: Partial<CompiledField> & { min?: number; max?: number } = {},
): CompiledField {
  const { min, max, ...rest } = extra;
  return cf(name, 'blocks', {
    ...rest,
    options: { allowedBlocks, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) },
  });
}

export function coll(name: string, fields: CompiledField[]): CompiledCollection {
  return {
    id: `c-${name}`,
    name,
    label: null,
    pluralLabel: null,
    hidden: false,
    system: false,
    singleton: false,
    icon: null,
    color: null,
    note: null,
    primaryKeyField: 'id',
    primaryKeyType: 'nanoid',
    storageMode: 'jsonb',
    displayTemplate: null,
    sortField: null,
    archiveField: null,
    archiveValue: null,
    unarchiveValue: null,
    itemDuplicationFields: [],
    translations: {},
    accountability: 'all',
    versioning: false,
    meta: {},
    systemFields: [],
    fields,
  };
}

/**
 * A small site: `pages.sections` accepts `hero`, `cta` and `columns`;
 * `columns.items` nests another zone accepting `hero` and `cta`.
 */
export const hero = coll('hero', [
  cf('title', 'string', { required: true }),
  cf('subtitle', 'text'),
  cf('height', 'integer', { validation: { rules: [{ rule: 'min', options: 0 }] } }),
]);
export const cta = coll('cta', [
  cf('label', 'string', { required: true }),
  cf('url', 'string', { validation: { rules: [{ rule: 'url' }] } }),
]);
export const columns = coll('columns', [cf('gap', 'integer'), blocksField('items', ['hero', 'cta'])]);
export const pages = coll('pages', [
  cf('title', 'string'),
  blocksField('sections', ['hero', 'cta', 'columns']),
]);

export const ALL = [hero, cta, columns, pages];

export async function getCompiledFrom(
  list: CompiledCollection[],
  name: string,
): Promise<CompiledCollection | null> {
  return list.find((c) => c.name === name) ?? null;
}
