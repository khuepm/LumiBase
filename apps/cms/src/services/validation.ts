import { z, type ZodTypeAny } from 'zod';
import { checkSlug, codePointLength, type SlugPolicy } from '@lumibase/contracts/field';
import { SINGLE_CHOICE_INTERFACES, TEXT_LENGTH_FIELD_TYPES } from '@lumibase/contracts/schemas';
import {
  isZonedDateTimeField,
  normalizeZonedDateTime,
  ZonedDateTimeError,
  type ZonedDateTimeFieldOptions,
} from '@lumibase/contracts/field';
import type { CompiledField } from './schema-service';

/**
 * Validation pipeline. Walks the compiled field manifest and builds a Zod
 * schema, then runs the payload through it. JSONata-like rules from
 * `field.validation.rules` are translated into refinements.
 *
 * Phase B keeps it minimal: type-aware base + required/min/max/regex/choices.
 * JSONata expression evaluation lands in Phase B.2 once `jsonata` is wired.
 */

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
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

/**
 * Timezone-aware datetime (#747): accepts `{ instant, tz }`, `{ local, tz }`
 * or an ISO string and normalizes it to `{ instant, tz, offset }`. The
 * string/number rules (`min`, `regex`, …) do not apply to this shape.
 */
function buildZonedFieldSchema(field: CompiledField): ZodTypeAny {
  const options = field.options as ZonedDateTimeFieldOptions;
  const core = z.unknown().transform((value, ctx) => {
    if (value === null || value === undefined) {
      if (field.required) {
        ctx.addIssue({ code: 'custom', message: 'Required' });
        return z.NEVER;
      }
      return null;
    }
    try {
      return normalizeZonedDateTime(value, options);
    } catch (err) {
      if (err instanceof ZonedDateTimeError) {
        ctx.addIssue({ code: 'custom', message: `${err.code}: ${err.message}` });
        return z.NEVER;
      }
      throw err;
    }
  });
  return field.required ? core : core.optional();
}

function buildFieldSchema(field: CompiledField): ZodTypeAny {
  if (isZonedDateTimeField(field)) return buildZonedFieldSchema(field);
  let schema = (TYPE_BASE[field.type] ?? (() => z.unknown()))();

  const rules = (field.validation?.rules as RuleObject[] | undefined) ?? [];

  for (const rule of rules) {
    schema = applyRule(schema, rule);
  }

  schema = applyOptionParity(schema, field);

  if (!field.required) schema = schema.nullable().optional();
  return schema;
}

const isEmptyValue = (v: unknown) => v === null || v === undefined || v === '';

/**
 * #751 — `options.minLength` / `options.maxLength` (Unicode code points, not
 * UTF-16 units) and `options.slug` (charset policy) on string/text fields.
 * An empty string counts as "no value" for `minLength` (use `required` to
 * forbid it). Fields without these options keep their previous behaviour.
 */
function applyOptionParity(schema: ZodTypeAny, field: CompiledField): ZodTypeAny {
  if (!(TEXT_LENGTH_FIELD_TYPES as readonly string[]).includes(field.type)) return schema;
  const opts = (field.options ?? {}) as Record<string, unknown>;
  const minLength = typeof opts.minLength === 'number' ? opts.minLength : undefined;
  const maxLength = typeof opts.maxLength === 'number' ? opts.maxLength : undefined;
  const slug = opts.slug && typeof opts.slug === 'object' ? (opts.slug as SlugPolicy) : undefined;
  if (minLength === undefined && maxLength === undefined && !slug) return schema;
  const name = field.name;
  return schema.superRefine((value: unknown, ctx) => {
    if (typeof value !== 'string') return;
    const len = codePointLength(value);
    if (maxLength !== undefined && len > maxLength) {
      ctx.addIssue({
        code: 'custom',
        params: { code: 'too_long' },
        message: `Field "${name}" must be at most ${maxLength} characters (Unicode code points); received ${len}.`,
      });
    }
    if (minLength !== undefined && value !== '' && len < minLength) {
      ctx.addIssue({
        code: 'custom',
        params: { code: 'too_short' },
        message: `Field "${name}" must be at least ${minLength} characters (Unicode code points); received ${len}.`,
      });
    }
    if (slug && value !== '') {
      const reason = checkSlug(value, slug);
      if (reason) {
        ctx.addIssue({
          code: 'custom',
          params: { code: 'invalid_slug' },
          message: `Field "${name}" ${reason} (slug charset "${slug.charset}").`,
        });
      }
    }
  });
}

/**
 * #751 — `options.allowClear === false` on a single-choice field: once the
 * stored value is set, a write may change it but not clear it (null / "").
 * Creation and still-empty items are unaffected. Independent of `required`
 * (which already rejects null on every write).
 */
function nonClearableIssues(
  compiledFields: CompiledField[],
  data: Record<string, unknown>,
  current: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const f of compiledFields) {
    if (!(SINGLE_CHOICE_INTERFACES as readonly string[]).includes(f.interface)) continue;
    if ((f.options as Record<string, unknown> | undefined)?.allowClear !== false) continue;
    if (!Object.prototype.hasOwnProperty.call(data, f.name)) continue;
    if (!isEmptyValue(data[f.name]) || isEmptyValue(current[f.name])) continue;
    issues.push({
      field: f.name,
      code: 'not_clearable',
      message: `Field "${f.name}" cannot be cleared once set (allowClear: false); choose another value instead.`,
    });
  }
  return issues;
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
  options: {
    partial?: boolean;
    /** Stored item data before this write (updates only) — enables `allowClear: false`. */
    current?: Record<string, unknown> | null;
  } = {},
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: ValidationIssue[] } {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of compiledFields) {
    if (options.partial && data[f.name] === undefined) continue;
    shape[f.name] = buildFieldSchema(f);
  }
  const schema = z.looseObject(shape);
  const result = schema.safeParse(data);
  const clearIssues = options.current ? nonClearableIssues(compiledFields, data, options.current) : [];
  if (result.success && clearIssues.length === 0) return { ok: true, data: result.data };

  const zodIssues: ValidationIssue[] = result.success
    ? []
    : result.error.issues.map((i) => {
        const custom = (i as { params?: { code?: unknown } }).params?.code;
        return {
          field: i.path.join('.'),
          code: i.code === 'custom' && typeof custom === 'string' ? custom : i.code,
          message: i.message,
        };
      });
  return { ok: false, issues: [...zodIssues, ...clearIssues] };
}
