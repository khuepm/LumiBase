import { RICHTEXT_ZOD } from './richtext';
import type { TypegenCollection, TypegenField, TypegenManifest } from './types';
import { capitalize, fieldShape, isNullable, isOptional, propertyKey } from './shared';

/** Module the generated validators import `z` from. */
export const DEFAULT_ZOD_IMPORT = 'zod';

export interface GenerateZodOptions {
  /** Module specifier for `import { z } from '…'`. Defaults to `zod`. */
  importSource?: string;
}

/**
 * Generates Zod runtime validators that mirror {@link generateTypes}: one
 * `<Name>Schema` per collection, an inferred `<Name>` type, and a
 * `LumibaseSchemas` map keyed by collection name.
 *
 * Optionality and nullability follow the TS generator exactly (`?` when not
 * required, `| null` when not required or nullable). The output uses only the
 * API surface shared by Zod 3 and Zod 4.
 *
 * Two deliberate differences from the TS types, both toward what the API
 * actually returns: branded ids validate as plain strings (a brand is a
 * compile-time marker), and to-many relations accept an id or an expanded
 * object per entry (the REST API returns ids unless the relation is expanded).
 */
export function generateZod(manifest: TypegenManifest, options: GenerateZodOptions = {}): string {
  const importSource = options.importSource ?? DEFAULT_ZOD_IMPORT;
  const byName = new Map(manifest.collections.map((collection) => [collection.name, collection]));

  const blocks = manifest.collections.map((collection) => {
    const name = capitalize(collection.name);
    const props = collection.fields
      .map((field) => `  ${propertyKey(field.name)}: ${fieldValidator(field, collection, byName)},`)
      .join('\n');
    return [
      `export const ${name}Schema = z.object({`,
      props,
      '});',
      `export type ${name} = z.infer<typeof ${name}Schema>;`,
    ]
      .filter((line) => line !== '')
      .join('\n');
  });

  const map = [
    'export const LumibaseSchemas = {',
    ...manifest.collections.map(
      (collection) => `  ${propertyKey(collection.name)}: ${capitalize(collection.name)}Schema,`,
    ),
    '} as const;',
  ].join('\n');

  return [`import { z } from ${JSON.stringify(importSource)};`, ...blocks, map].join('\n\n');
}

function fieldValidator(
  field: TypegenField,
  collection: TypegenCollection,
  byName: ReadonlyMap<string, TypegenCollection>,
): string {
  const shape = fieldShape(field);
  let schema: string;

  switch (shape.kind) {
    case 'to-many': {
      const target = byName.get(shape.target);
      const id = target ? primaryKeyValidator(target) : 'z.union([z.string(), z.number()])';
      // TS `Target[]` is not wrapped in `| null`, so neither is this.
      return withOptional(field, `z.array(z.union([${id}, z.record(z.string(), z.unknown())]))`);
    }
    case 'm2a':
      return withOptional(
        field,
        'z.array(z.object({ collection: z.string(), item: z.unknown() }))',
      );
    case 'localized':
      schema = 'z.record(z.string(), z.string())';
      break;
    case 'file':
      schema = 'z.string()';
      break;
    case 'files':
      schema = 'z.array(z.string())';
      break;
    case 'enum':
      return wrap(field, `z.enum(${JSON.stringify(shape.values)})`);
    case 'primary-key':
      return wrap(field, primaryKeyValidator(collection));
    case 'm2o':
      // Same as the TS generator: the stored foreign key, typed by its own storage type.
      return wrap(field, scalarValidator(field.type));
    case 'scalar':
      schema = scalarValidator(field.type);
      break;
  }

  if (field.encrypted) schema = `z.union([${schema}, z.literal('***')])`;
  return wrap(field, schema);
}

function primaryKeyValidator(collection: TypegenCollection): string {
  const type = collection.primaryKeyType ?? 'nanoid';
  return type === 'integer' || type === 'bigInteger' ? 'z.number().int()' : 'z.string()';
}

function scalarValidator(type: string): string {
  switch (type) {
    case 'string':
    case 'text':
    case 'hash':
    case 'csv':
    case 'uuid':
    case 'date':
    case 'datetime':
    case 'dateTime':
    case 'time':
    case 'timestamp':
      return 'z.string()';
    case 'integer':
      return 'z.number().int()';
    case 'bigInteger':
    case 'decimal':
    case 'float':
      return 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'geometry':
      return 'z.record(z.string(), z.unknown())';
    case 'richtext':
      return RICHTEXT_ZOD;
    default:
      // `json` and anything unrecognised: the TS type is `unknown`.
      return 'z.unknown()';
  }
}

function wrap(field: TypegenField, schema: string): string {
  return withOptional(field, isNullable(field) ? `${schema}.nullable()` : schema);
}

function withOptional(field: TypegenField, schema: string): string {
  return isOptional(field) ? `${schema}.optional()` : schema;
}
