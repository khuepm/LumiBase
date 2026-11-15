import { z, type ZodTypeAny } from 'zod';
import type { CompiledField } from './schema-service';
import {
  BLOCK_ID_PATTERN,
  BLOCK_KEYS,
  MAX_BLOCK_DEPTH,
  MAX_BLOCKS_PER_FIELD,
  isBlocksField,
  newBlockId,
  readBlocksOptions,
  type BlockTemplateMap,
} from './blocks';

/**
 * Validation pipeline. Walks the compiled field manifest and builds a Zod
 * schema, then runs the payload through it. JSONata-like rules from
 * `field.validation.rules` are translated into refinements.
 *
 * Phase B keeps it minimal: type-aware base + required/min/max/regex/choices.
 * JSONata expression evaluation lands in Phase B.2 once `jsonata` is wired.
 */

export interface ValidationIssue {
  /** Dotted path, e.g. `sections.2.data.title`. */
  field: string;
  code: string;
  message: string;
  /** Path segments (array indices stay numbers) — precise for nested blocks. */
  path?: Array<string | number>;
}

export interface ValidateItemOptions {
  partial?: boolean;
  /**
   * Block templates reachable from these fields (see `resolveBlockTemplates`).
   * A `blocks` field whose template is absent here rejects that block — the
   * validator fails closed rather than accepting unchecked data.
   */
  blockTemplates?: BlockTemplateMap;
  /** Current `blocks` nesting depth (internal; 0 at the item level). */
  depth?: number;
}

interface SchemaContext {
  blockTemplates: BlockTemplateMap;
  depth: number;
}

interface RuleObject {
  rule: string;
  options?: unknown;
  message?: string;
}

const TYPE_BASE: Record<string, () => ZodTypeAny> = {
  string: () => z.string(),
  text: () => z.string(),
  hash: () => z.string(),
  csv: () => z.string(),
  uuid: () => z.string().uuid(),
  integer: () => z.number().int(),
  bigInteger: () => z.number(),
  decimal: () => z.number(),
  boolean: () => z.boolean(),
  json: () => z.unknown(),
  date: () => z.string(),
  datetime: () => z.string(),
  time: () => z.string(),
  timestamp: () => z.string(),
};

function buildFieldSchema(field: CompiledField, ctx: SchemaContext): ZodTypeAny {
  if (isBlocksField(field)) return buildBlocksSchema(field, ctx);
  let schema = (TYPE_BASE[field.type] ?? (() => z.unknown()))();

  const rules = (field.validation?.rules as RuleObject[] | undefined) ?? [];

  for (const rule of rules) {
    schema = applyRule(schema, rule);
  }

  if (!field.required) schema = schema.nullable().optional();
  return schema;
}

function applyRule(schema: ZodTypeAny, rule: RuleObject): ZodTypeAny {
  const message = rule.message;
  switch (rule.rule) {
    case 'min':
      if (schema instanceof z.ZodString) return schema.min(rule.options as number, { message });
      if (schema instanceof z.ZodNumber) return schema.min(rule.options as number, { message });
      return schema;
    case 'max':
      if (schema instanceof z.ZodString) return schema.max(rule.options as number, { message });
      if (schema instanceof z.ZodNumber) return schema.max(rule.options as number, { message });
      return schema;
    case 'regex':
      if (schema instanceof z.ZodString)
        return schema.regex(new RegExp(rule.options as string), { message });
      return schema;
    case 'choices': {
      const choices = rule.options as string[];
      if (!Array.isArray(choices) || choices.length === 0) return schema;
      const set = new Set(choices);
      return schema.refine((v: unknown) => set.has(v as string), {
        message: message ?? `Must be one of ${choices.join(', ')}`,
      });
    }
    case 'email':
      if (schema instanceof z.ZodString) return schema.email({ message });
      return schema;
    case 'url':
      if (schema instanceof z.ZodString) return schema.url({ message });
      return schema;
    default:
      return schema;
  }
}

export function validateItem(
  compiledFields: CompiledField[],
  data: Record<string, unknown>,
  options: ValidateItemOptions = {},
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: ValidationIssue[] } {
  const ctx: SchemaContext = {
    blockTemplates: options.blockTemplates ?? new Map(),
    depth: options.depth ?? 0,
  };
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of compiledFields) {
    if (options.partial && data[f.name] === undefined) continue;
    shape[f.name] = buildFieldSchema(f, ctx);
  }
  const schema = z.looseObject(shape);
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };

  return {
    ok: false,
    issues: result.error.issues.map((i) => {
      const path = i.path.filter((p): p is string | number => typeof p !== 'symbol');
      // Block issues are raised as `custom` with the semantic code in params.
      const params = (i as { params?: { code?: unknown } }).params;
      const code = typeof params?.code === 'string' ? params.code : i.code;
      return { field: path.join('.'), code, message: i.message, path };
    }),
  };
}

// ---------------------------------------------------------------------------
// Dynamic zones (#748): `blocks` fields
// ---------------------------------------------------------------------------

type IssueSink = (path: Array<string | number>, message: string, code?: string) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Zod schema for one `blocks` field. `null` normalises to `[]` (Strapi #26816
 * class: a null zone must never crash a reader); a missing optional value
 * stays missing. Each block is checked against its template's compiled fields
 * through `validateItem` itself, so nested `blocks` fields recurse — bounded
 * by `MAX_BLOCK_DEPTH`. Every issue carries the exact path
 * (`[index, 'data', field, …]`) relative to the field. Blocks without an id
 * get a fresh nanoid; the output is the canonical `{ id, type, data }` list.
 */
function buildBlocksSchema(field: CompiledField, ctx: SchemaContext): ZodTypeAny {
  const opts = readBlocksOptions(field.options);
  const allowed = new Set(opts.allowedBlocks);
  // A required zone needs at least one block — an empty list is "nothing".
  const min = field.required ? Math.max(opts.min ?? 0, 1) : opts.min;

  const inner = z.unknown().transform((value, zctx) => {
    let failed = false;
    const sink: IssueSink = (path, message, code = 'custom') => {
      failed = true;
      zctx.addIssue({ code: 'custom', message, path, params: { code } });
    };
    if (value === undefined) {
      sink([], 'Required', 'invalid_type');
      return z.NEVER;
    }
    if (!Array.isArray(value)) {
      sink([], 'Expected an array of blocks', 'invalid_type');
      return z.NEVER;
    }
    if (value.length > MAX_BLOCKS_PER_FIELD) {
      sink([], `At most ${MAX_BLOCKS_PER_FIELD} blocks are allowed in one field`, 'too_big');
      return z.NEVER;
    }
    if (value.length > 0 && ctx.depth >= MAX_BLOCK_DEPTH) {
      sink([], `Blocks may be nested at most ${MAX_BLOCK_DEPTH} levels deep`, 'too_big');
      return z.NEVER;
    }
    if (min !== undefined && value.length < min) {
      sink([], `Expected at least ${min} block${min === 1 ? '' : 's'}`, 'too_small');
    }
    if (opts.max !== undefined && value.length > opts.max) {
      sink([], `Expected at most ${opts.max} block${opts.max === 1 ? '' : 's'}`, 'too_big');
    }

    const seenIds = new Set<string>();
    const out: Array<{ id: string; type: string; data: Record<string, unknown> }> = [];
    value.forEach((raw, index) => {
      const block = validateBlock(raw, index, allowed, ctx, seenIds, sink);
      if (block) out.push(block);
    });
    return failed ? z.NEVER : out;
  });

  const schema = z.preprocess((v) => (v === null ? [] : v), inner);
  return field.required ? schema : schema.optional();
}

function validateBlock(
  raw: unknown,
  index: number,
  allowed: ReadonlySet<string>,
  ctx: SchemaContext,
  seenIds: Set<string>,
  sink: IssueSink,
): { id: string; type: string; data: Record<string, unknown> } | null {
  if (!isPlainObject(raw)) {
    sink([index], 'Block must be an object with `type` and `data`', 'invalid_type');
    return null;
  }
  let ok = true;
  const fail: IssueSink = (path, message, code) => {
    ok = false;
    sink([index, ...path], message, code);
  };

  for (const key of Object.keys(raw)) {
    if (!BLOCK_KEYS.has(key)) fail([key], `Unknown block property "${key}"`, 'unrecognized_keys');
  }

  // id — server-assigned nanoid when absent; stable across edits otherwise.
  let id: string;
  if (raw.id === undefined || raw.id === null) {
    id = newBlockId();
  } else if (typeof raw.id !== 'string' || !BLOCK_ID_PATTERN.test(raw.id)) {
    fail(['id'], 'Block id must be 1–64 URL-safe characters', 'invalid_format');
    id = '';
  } else {
    id = raw.id;
  }
  if (id) {
    if (seenIds.has(id)) fail(['id'], `Duplicate block id "${id}"`, 'custom');
    seenIds.add(id);
  }

  // type — must be allowed here AND resolve to an existing template.
  const type = raw.type;
  if (typeof type !== 'string' || type.length === 0) {
    fail(['type'], 'Block type is required', 'invalid_type');
    return null;
  }
  if (!allowed.has(type)) {
    const list = [...allowed].join(', ') || 'none';
    fail(['type'], `Block type "${type}" is not allowed here (allowed: ${list})`, 'invalid_value');
    return null;
  }
  const templateFields = ctx.blockTemplates.get(type);
  if (!templateFields) {
    fail(['type'], `Block template "${type}" does not exist`, 'invalid_value');
    return null;
  }

  // data — null/missing is an empty block, never a crash.
  const rawData = raw.data === undefined || raw.data === null ? {} : raw.data;
  if (!isPlainObject(rawData)) {
    fail(['data'], 'Block data must be an object', 'invalid_type');
    return null;
  }

  const known = new Map(templateFields.map((f) => [f.name, f]));
  for (const [key, v] of Object.entries(rawData)) {
    const f = known.get(key);
    if (!f) {
      fail(['data', key], `Unknown field "${key}" for block type "${type}"`, 'unrecognized_keys');
      continue;
    }
    // Field-level encryption is applied to top-level item fields only; a
    // value inside a block would be stored in clear. Fail closed.
    if ((f.encrypted || f.classification === 'pii' || f.classification === 'phi') && v !== null && v !== undefined) {
      fail(['data', key], 'Encrypted or pii/phi fields are not supported inside blocks', 'custom');
    }
  }

  const nested = validateItem(templateFields, rawData, {
    blockTemplates: ctx.blockTemplates,
    depth: ctx.depth + 1,
  });
  if (!nested.ok) {
    for (const issue of nested.issues) {
      fail(['data', ...(issue.path ?? issue.field.split('.'))], issue.message, issue.code);
    }
    return null;
  }
  return ok ? { id, type, data: nested.data } : null;
}
