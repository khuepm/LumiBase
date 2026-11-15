import type { TypegenCollection, TypegenField, TypegenManifest, TypegenRelation } from './types';

/** Interface id of a per-locale text map (`{ en: 'Hi', vi: 'Chào' }`). */
export const TRANSLATABLE_INTERFACE = 'translatable-text';
/** Interface id of a single file reference (a file id). */
export const FILE_INTERFACE = 'file';
/** Interface id of a multi-file reference (an array of file ids). */
export const FILES_INTERFACE = 'files';

/** Wire shape of a field, independent of the output language. */
export type FieldShape =
  | { kind: 'm2o' }
  | { kind: 'to-many'; target: string }
  | { kind: 'm2a' }
  | { kind: 'localized' }
  | { kind: 'file' }
  | { kind: 'files' }
  | { kind: 'enum'; values: string[] }
  | { kind: 'primary-key' }
  | { kind: 'scalar' };

/**
 * Classifies a field the same way for every target, in the order the TS
 * generator has always used: relation kind first, then the interfaces whose
 * wire value differs from the storage type, then enums, then scalars.
 */
export function fieldShape(field: TypegenField): FieldShape {
  if (field.kind === 'm2o') return { kind: 'm2o' };
  if (field.kind === 'o2m' || field.kind === 'm2m') {
    return { kind: 'to-many', target: field.target || 'unknown' };
  }
  if (field.kind === 'm2a') return { kind: 'm2a' };
  if (field.interface === TRANSLATABLE_INTERFACE) return { kind: 'localized' };
  if (field.interface === FILES_INTERFACE || field.type === 'files') return { kind: 'files' };
  if (field.interface === FILE_INTERFACE) return { kind: 'file' };
  if (field.enum && field.enum.length > 0) return { kind: 'enum', values: field.enum };
  if (field.primaryKey) return { kind: 'primary-key' };
  return { kind: 'scalar' };
}

/** Optional (`?`) when not required — mirrors the TS generator. */
export function isOptional(field: TypegenField): boolean {
  return !field.required;
}

/** `| null` when not required or explicitly nullable — mirrors the TS generator. */
export function isNullable(field: TypegenField): boolean {
  return !field.required || field.nullable;
}

export function hasIntegerPrimaryKey(collection: TypegenCollection | undefined): boolean {
  return collection?.primaryKeyType === 'integer' || collection?.primaryKeyType === 'bigInteger';
}

export function relationsOf(collection: TypegenCollection): TypegenRelation[] {
  return collection.relations ?? [];
}

/** `articles` → `Articles` — the TS / Zod type name (matches `generateTypes`). */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Object key as written in generated TS/JS source. */
export function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/**
 * Keeps only the collections a config asked for. Applied client-side as well
 * as on the server so a saved manifest file honours `include` / `exclude` too.
 */
export function filterManifest(
  manifest: TypegenManifest,
  filters: { include?: readonly string[]; exclude?: readonly string[] },
): TypegenManifest {
  const { include, exclude } = filters;
  if (!include?.length && !exclude?.length) return manifest;
  return {
    ...manifest,
    collections: manifest.collections.filter(
      (collection) =>
        (!include?.length || include.includes(collection.name)) &&
        !(exclude?.length && exclude.includes(collection.name)),
    ),
  };
}
