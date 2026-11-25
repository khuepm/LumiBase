/**
 * File references inside item `data` (#853, design §2.1 / §3.2 / §8.2).
 *
 * Item ids are kept across a fork, so item→item references need no rewriting.
 * File rows (`lumibase_files`) keep an instance-wide primary key, so the fork
 * gives each copied file a new id and every reference to it inside `data` must
 * be mapped: origin → environment at fork time, environment → origin at
 * promote time.
 *
 * A file reference is a field whose Studio interface is `file` (one id, a
 * string) or `files` (an array of ids) — the same rule typegen uses
 * (`packages/sdk/src/typegen/shared.ts`). Rich-text embeds and free-form JSON
 * are not scanned in v1: a file id there keeps the origin value (documented
 * limit).
 *
 * Pure.
 */

import type { ItemData } from './base';

export type FileFieldKind = 'file' | 'files';

export interface FieldShape {
  name: string;
  interface: string | null;
}

/** Fields of a collection that hold file ids, by name. */
export function fileFieldsOf(fields: readonly FieldShape[]): Map<string, FileFieldKind> {
  const out = new Map<string, FileFieldKind>();
  for (const f of fields) {
    if (f.interface === 'file') out.set(f.name, 'file');
    else if (f.interface === 'files') out.set(f.name, 'files');
  }
  return out;
}

/** Every file id referenced by `data` through the given fields. */
export function collectFileIds(data: ItemData, fileFields: ReadonlyMap<string, FileFieldKind>): string[] {
  const ids: string[] = [];
  for (const [name, kind] of fileFields) {
    const value = data[name];
    if (kind === 'file') {
      if (typeof value === 'string' && value) ids.push(value);
    } else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string' && v) ids.push(v);
    }
  }
  return ids;
}

/**
 * Copy of `data` with every file id mapped through `map`. An id absent from
 * the map is kept as is (caller decides whether that is an error).
 */
export function rewriteFileIds(
  data: ItemData,
  fileFields: ReadonlyMap<string, FileFieldKind>,
  map: ReadonlyMap<string, string>,
): ItemData {
  if (fileFields.size === 0) return data;
  const out: ItemData = { ...data };
  for (const [name, kind] of fileFields) {
    const value = out[name];
    if (kind === 'file') {
      if (typeof value === 'string' && map.has(value)) out[name] = map.get(value);
    } else if (Array.isArray(value)) {
      out[name] = value.map((v) => (typeof v === 'string' && map.has(v) ? map.get(v) : v));
    }
  }
  return out;
}
