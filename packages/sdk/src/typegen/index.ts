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
  const imports = [
    `import type { ID, Locale } from '${importSource}';`,
    branded ? `import type { Brand } from '${importSource}';` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const collectionInterfaces = manifest.collections
    .map((coll) => {
      const base = generateCollectionInterface(coll, branded);
      const expanded = generateExpandedType(coll);
      return [base, expanded].filter(Boolean).join('\n\n');
    })
    .join('\n\n');

  const collectionsMap = `export interface LumibaseCollections {
${manifest.collections.map((c) => `  ${c.name}: ${capitalize(c.name)};`).join('\n')}
}`;

  const schemaType = 'export type LumibaseSchema = LumibaseCollections;';

  return `${imports}\n\n${collectionInterfaces}\n\n${collectionsMap}\n\n${schemaType}`;
}

function generatePerCollection(manifest: TypegenManifest, branded: boolean, importSource: string): string {
  // For per-collection format, return a map of filename -> content
  // This is a placeholder - actual implementation would return an object
  return generateSingleFile(manifest, branded, importSource);
}

function generateCollectionInterface(coll: TypegenManifest['collections'][0], branded: boolean): string {
  const fields = coll.fields
    .map((f) => {
      const tsType = mapFieldTypeToTs(f, coll, branded);
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

function mapFieldTypeToTs(field: TypegenField, coll: TypegenCollection, branded: boolean): string {
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

function mapScalarFieldType(field: TypegenField, branded: boolean): string {
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
