import { nanoid } from 'nanoid';
import type { CompiledCollection, CompiledField } from './schema-service';

/**
 * Dynamic zones (#748) — the `blocks` field type.
 *
 * A `blocks` field stores an ordered, polymorphic list of blocks inline in the
 * item's JSONB `data`:
 *
 *   [{ id: '<nanoid>', type: 'hero', data: { title: 'Hi' } }, …]
 *
 * A **block template** is an ordinary collection of the same site: its user
 * fields are the block's schema, and its machine name is the block `type`.
 * The field lists which templates it accepts in `options.allowedBlocks`
 * (plus optional `options.min` / `options.max`). Block values are validated
 * per block against the template's compiled fields with the same validator
 * the collection fields use (`validateItem`), recursively for nested `blocks`
 * fields, bounded by {@link MAX_BLOCK_DEPTH}.
 *
 * This module holds the pure config parsing and template resolution; the
 * per-block validation lives in `validation.ts` next to the field validator.
 */

export const BLOCKS_FIELD_TYPE = 'blocks';
/** Maximum nesting of `blocks` fields inside block templates. */
export const MAX_BLOCK_DEPTH = 5;
/** Hard cap on blocks in one list — bounds validation cost per write. */
export const MAX_BLOCKS_PER_FIELD = 500;
/** Hard cap on distinct templates resolved for one write. */
export const MAX_BLOCK_TEMPLATES = 64;
/** Block ids: nanoid alphabet, generous length so imported ids still fit. */
export const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Block keys a stored block may carry; anything else is rejected. */
export const BLOCK_KEYS: ReadonlySet<string> = new Set(['id', 'type', 'data']);

const TEMPLATE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

export interface BlocksFieldOptions {
  allowedBlocks: string[];
  min?: number;
  max?: number;
}

/** Template name → its compiled (user) fields. */
export type BlockTemplateMap = ReadonlyMap<string, CompiledField[]>;

export function isBlocksField(field: Pick<CompiledField, 'type'>): boolean {
  return field.type === BLOCKS_FIELD_TYPE;
}

/**
 * Read `options` of a `blocks` field leniently (for runtime use). Malformed
 * entries are dropped, never thrown — strict checking happens at schema
 * write time in {@link blocksFieldConfigProblems}.
 */
export function readBlocksOptions(options: Record<string, unknown> | null | undefined): BlocksFieldOptions {
  const raw = options ?? {};
  const allowed = Array.isArray(raw.allowedBlocks)
    ? raw.allowedBlocks.filter((v): v is string => typeof v === 'string' && TEMPLATE_NAME.test(v))
    : [];
  const out: BlocksFieldOptions = { allowedBlocks: [...new Set(allowed)] };
  if (isCount(raw.min)) out.min = raw.min;
  if (isCount(raw.max)) out.max = raw.max;
  return out;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_BLOCKS_PER_FIELD;
}

/**
 * Strict schema-write check for a `blocks` field definition. Returns a list of
 * human-readable problems (empty = valid). Template *existence* is checked at
 * item-write time instead, so a schema apply / config import can create the
 * field before its template collections in the same batch.
 */
export function blocksFieldConfigProblems(input: {
  type?: string;
  options?: Record<string, unknown> | null;
  encrypted?: boolean | null;
}): string[] {
  if (input.type !== BLOCKS_FIELD_TYPE) return [];
  const problems: string[] = [];
  const opts = input.options ?? {};
  const allowed = opts.allowedBlocks;
  if (!Array.isArray(allowed) || allowed.length === 0) {
    problems.push('options.allowedBlocks must be a non-empty array of block template (collection) names.');
  } else {
    const seen = new Set<string>();
    allowed.forEach((name, i) => {
      if (typeof name !== 'string' || !TEMPLATE_NAME.test(name)) {
        problems.push(`options.allowedBlocks[${i}] must be a collection machine name.`);
      } else if (seen.has(name)) {
        problems.push(`options.allowedBlocks[${i}] duplicates "${name}".`);
      } else {
        seen.add(name);
      }
    });
  }
  for (const key of ['min', 'max'] as const) {
    if (opts[key] !== undefined && opts[key] !== null && !isCount(opts[key])) {
      problems.push(`options.${key} must be an integer between 0 and ${MAX_BLOCKS_PER_FIELD}.`);
    }
  }
  if (isCount(opts.min) && isCount(opts.max) && opts.min > opts.max) {
    problems.push('options.min must not exceed options.max.');
  }
  if (input.encrypted) {
    problems.push('A blocks field cannot be encrypted; encrypt nothing inside block templates either.');
  }
  return problems;
}

/**
 * Resolve every block template reachable from `fields` (breadth-first through
 * nested `blocks` fields, bounded by depth and template count). Templates that
 * do not exist are simply absent from the map — the validator then rejects a
 * block of that type, failing closed.
 */
export async function resolveBlockTemplates(
  fields: CompiledField[],
  getCompiled: (name: string) => Promise<CompiledCollection | null>,
  maxDepth: number = MAX_BLOCK_DEPTH,
): Promise<Map<string, CompiledField[]>> {
  const out = new Map<string, CompiledField[]>();
  const visited = new Set<string>();
  let frontier = fields;
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const names = new Set<string>();
    for (const f of frontier) {
      if (!isBlocksField(f)) continue;
      for (const name of readBlocksOptions(f.options).allowedBlocks) {
        if (!visited.has(name)) names.add(name);
      }
    }
    const next: CompiledField[] = [];
    for (const name of names) {
      if (visited.size >= MAX_BLOCK_TEMPLATES) break;
      visited.add(name);
      const compiled = await getCompiled(name);
      if (!compiled) continue;
      out.set(name, compiled.fields);
      next.push(...compiled.fields);
    }
    frontier = next;
  }
  return out;
}

/** True when `fields` declares any `blocks` field (cheap pre-check). */
export function hasBlocksFields(fields: CompiledField[]): boolean {
  return fields.some(isBlocksField);
}

/** Block ids are nanoids, like every other domain id (CLAUDE.md rule 1). */
export function newBlockId(): string {
  return nanoid();
}
