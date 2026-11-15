import type { TypegenCollection, TypegenField, TypegenManifest, TypegenRelation } from './types';
export type { TypegenManifest, TypegenCollection, TypegenField, TypegenRelation } from './types';

/** Default module specifier the generated file imports `ID` / `Locale` / `Brand` from. */
export const DEFAULT_IMPORT_SOURCE = '@lumibase/sdk';

export interface GenerateOptions {
  format?: 'single' | 'per-collection';
  branded?: boolean;
  /**
   * Module the generated file imports its helper types from. Defaults to
   * `@lumibase/sdk`; the `lumibase` package re-exports the SDK, so a project
   * that installs only `lumibase` should pass 'lumibase' here.
   */
  importSource?: string;
}

export function generateTypes(manifest: TypegenManifest, options: GenerateOptions = {}): string {
  const { format = 'single', branded = true, importSource = DEFAULT_IMPORT_SOURCE } = options;

  if (format === 'single') {
    return generateSingleFile(manifest, branded, importSource);
  }

  return generatePerCollection(manifest, branded, importSource);
}

function generateSingleFile(manifest: TypegenManifest, branded: boolean, importSource: string): string {
  const known: ReadonlySet<string> = new Set(manifest.collections.map((c) => c.name));
  const imports = [
    `import type { ID, Locale } from '${importSource}';`,
    branded ? `import type { Brand } from '${importSource}';` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const collectionInterfaces = manifest.collections
    .map((coll) => {
      const base = generateCollectionInterface(coll, branded, known);
      const expanded = generateExpandedType(coll);
      return [base, expanded].filter(Boolean).join('\n\n');
    })
    .join('\n\n');

  const blockTypes = generateBlockTypes(manifest, branded, known);

  const collectionsMap = `export interface LumibaseCollections {
${manifest.collections.map((c) => `  ${c.name}: ${capitalize(c.name)};`).join('\n')}
}`;

  const schemaType = 'export type LumibaseSchema = LumibaseCollections;';

  const body = [collectionInterfaces, blockTypes, collectionsMap, schemaType].filter(Boolean).join('\n\n');
  return `${imports}\n\n${body}`;
}

function generatePerCollection(manifest: TypegenManifest, branded: boolean, importSource: string): string {
  // For per-collection format, return a map of filename -> content
  // This is a placeholder - actual implementation would return an object
  return generateSingleFile(manifest, branded, importSource);
}

function generateCollectionInterface(
  coll: TypegenManifest['collections'][0],
  branded: boolean,
  known: ReadonlySet<string>,
): string {
  const fields = coll.fields
    .map((f) => {
      const tsType = mapFieldTypeToTs(f, coll, branded, known);
      const optional = f.required ? '' : '?';
      const readonly = f.readonly || f.generated ? 'readonly ' : '';
      return `  ${readonly}${f.name}${optional}: ${tsType};`;
    })
    .join('\n');

  return `export interface ${capitalize(coll.name)} {
${fields}
}`;
}

function generateExpandedType(coll: TypegenCollection): string {
  const relations = coll.relations ?? [];
  if (relations.length === 0) {
    return `export type ${capitalize(coll.name)}Expanded = ${capitalize(coll.name)};`;
  }

  const omittedKeys = relations.map((relation) => quoteProperty(relation.field)).join(' | ');
  const fields = relations
    .map((relation) => `  ${relation.field}?: ${expandedRelationType(relation)};`)
    .join('\n');

  return `export type ${capitalize(coll.name)}Expanded = Omit<${capitalize(coll.name)}, ${omittedKeys}> & {
${fields}
};`;
}

function expandedRelationType(relation: TypegenRelation): string {
  if (relation.kind === 'm2o') {
    return `${capitalize(relation.target)} | ${capitalize(relation.target)}Expanded | null`;
  }
  if (relation.kind === 'o2m' || relation.kind === 'm2m') {
    return `Array<${capitalize(relation.target)} | ${capitalize(relation.target)}Expanded>`;
  }
  return `Array<{ collection: string; item: unknown }>`;
}

/**
 * Dynamic zones (#748): for every block template referenced by a `blocks`
 * field, emit `<Template>BlockData` (the template's user fields — block data
 * carries no system columns) and `<Template>Block`, the union member
 * discriminated on the literal `type`.
 */
function generateBlockTypes(manifest: TypegenManifest, branded: boolean, known: ReadonlySet<string>): string {
  const byName = new Map(manifest.collections.map((c) => [c.name, c]));
  const referenced = new Set<string>();
  for (const coll of manifest.collections) {
    for (const f of coll.fields) {
      if (f.type === 'blocks') for (const t of f.allowedBlocks ?? []) referenced.add(t);
    }
  }
  return [...referenced]
    .filter((name) => byName.has(name))
    .sort()
    .map((name) => {
      const coll = byName.get(name)!;
      const dataFields = coll.fields
        .filter((f) => !f.system && !f.primaryKey)
        .map((f) => {
          const optional = f.required ? '' : '?';
          return `  ${f.name}${optional}: ${mapFieldTypeToTs(f, coll, branded, known)};`;
        })
        .join('\n');
      const t = capitalize(name);
      return `export interface ${t}BlockData {
${dataFields}
}

export interface ${t}Block {
  id: string;
  type: ${JSON.stringify(name)};
  data: ${t}BlockData;
}`;
    })
    .join('\n\n');
}

function blocksUnionType(field: TypegenField, isKnown: (name: string) => boolean): string {
  const members = (field.allowedBlocks ?? []).map((name) =>
    isKnown(name)
      ? `${capitalize(name)}Block`
      : `{ id: string; type: ${JSON.stringify(name)}; data: Record<string, unknown> }`,
  );
  if (members.length === 0) return 'Array<{ id: string; type: string; data: Record<string, unknown> }>';
  return `Array<${members.join(' | ')}>`;
}

function mapFieldTypeToTs(
  field: TypegenField,
  coll: TypegenCollection,
  branded: boolean,
  known: ReadonlySet<string> = new Set(),
): string {
  if (field.type === 'blocks') {
    return nullable(field, blocksUnionType(field, (name) => known.has(name)));
  }
  if (field.kind === 'm2o') {
    return nullable(field, mapScalarFieldType(field, branded));
  }
  if (field.kind === 'o2m' || field.kind === 'm2m') {
    return `${capitalize(field.target || 'unknown')}[]`;
  }
  if (field.kind === 'm2a') {
    return `Array<{ collection: string; item: unknown }>`;
  }

  if (field.enum && field.enum.length > 0) {
    return nullable(field, field.enum.map((v) => JSON.stringify(v)).join(' | '));
  }

  if (field.primaryKey) {
    return nullable(
      field,
      mapPrimaryKeyType(coll.primaryKeyType ?? 'nanoid', branded, field.branded),
    );
  }

  const tsType = mapScalarFieldType(field, branded);

  return nullable(field, field.encrypted ? `${tsType} | '***'` : tsType);
}

/** Inline shape of a timezone-aware datetime (#747); mirrors `ZonedDateTime`. */
const ZONED_DATETIME_TS = '{ instant: string; tz: string; offset: string }';

function mapScalarFieldType(field: TypegenField, branded: boolean): string {
  if (field.timezone) return ZONED_DATETIME_TS;
  const typeMap: Record<string, string> = {
    string: 'string',
    text: 'string',
    hash: 'string',
    csv: 'string',
    integer: 'number',
    bigInteger: 'number',
    decimal: 'number',
    boolean: 'boolean',
    json: 'unknown',
    uuid: mapPrimaryKeyType('uuid', branded, field.branded),
    date: 'string',
    datetime: 'string',
    time: 'string',
    timestamp: 'string',
    geometry: 'GeoJSON.Geometry',
  };

  return typeMap[field.type] || 'unknown';
}

function nullable(field: TypegenField, tsType: string): string {
  if (!field.required || field.nullable) {
    return `${tsType} | null`;
  }

  return tsType;
}

function mapPrimaryKeyType(
  primaryKeyType: NonNullable<TypegenCollection['primaryKeyType']>,
  branded: boolean,
  brand?: string,
): string {
  if (primaryKeyType === 'integer' || primaryKeyType === 'bigInteger') return 'number';
  if (branded) return `Brand<'${brand || 'ID'}', string>`;
  return 'ID';
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function quoteProperty(name: string): string {
  return JSON.stringify(name);
}
