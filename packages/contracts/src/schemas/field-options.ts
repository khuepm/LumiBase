import { z } from 'zod';
import { compileSlugPattern, SLUG_PATTERN_MAX_LENGTH } from '../field/slug';

/**
 * Field option parity (#751): `allowClear`, `minLength`/`maxLength`, `slug`.
 *
 * Validated on every schema write (SchemaService create/update/rename field,
 * which REST, schema apply, config-as-code and MCP all go through) and
 * enforced on every item write by the CMS validation pipeline.
 *
 * `options` stays an open record — interfaces keep their own keys
 * (`choices`, `placeholder`, `rows`, …). Only the keys below are checked.
 */

/** Interfaces that store exactly one choice and honour `allowClear`. */
export const SINGLE_CHOICE_INTERFACES = ['select-radio', 'select-dropdown'] as const;
/** Field types whose string values honour `minLength`/`maxLength`/`slug`. */
export const TEXT_LENGTH_FIELD_TYPES = ['string', 'text'] as const;
/** Upper bound for a configurable length (Unicode code points). */
export const FIELD_TEXT_LENGTH_LIMIT = 1_000_000;

export const SlugPolicySchema = z
  .object({
    charset: z.enum(['ascii', 'unicode', 'custom']),
    pattern: z.string().min(1).max(SLUG_PATTERN_MAX_LENGTH * 2).optional(),
    lowercase: z.boolean().optional(),
    separator: z.enum(['-', '_', '.']).optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.charset === 'custom') {
      if (!policy.pattern) {
        ctx.addIssue({ code: 'custom', path: ['pattern'], message: 'slug.pattern is required when charset is "custom".' });
        return;
      }
      const compiled = compileSlugPattern(policy.pattern);
      if (!compiled.ok) {
        ctx.addIssue({ code: 'custom', path: ['pattern'], message: `slug.pattern rejected: ${compiled.error}.` });
      }
    } else if (policy.pattern !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['pattern'], message: 'slug.pattern is only allowed when charset is "custom".' });
    }
  });

const lengthBound = z.number().int().min(0).max(FIELD_TEXT_LENGTH_LIMIT);

export const FieldOptionParitySchema = z
  .looseObject({
    allowClear: z.boolean().optional(),
    minLength: lengthBound.optional(),
    maxLength: lengthBound.min(1).optional(),
    slug: SlugPolicySchema.optional(),
  })
  .superRefine((o, ctx) => {
    if (o.minLength !== undefined && o.maxLength !== undefined && o.minLength > o.maxLength) {
      ctx.addIssue({ code: 'custom', path: ['minLength'], message: 'minLength must not exceed maxLength.' });
    }
  });

export type SlugPolicyInput = z.infer<typeof SlugPolicySchema>;
export type FieldOptionParity = z.infer<typeof FieldOptionParitySchema>;

export interface FieldOptionContext {
  type: string;
  interface: string;
  options: unknown;
  /** Field `length` metadata; when set, `maxLength` may not exceed it. */
  length?: number | null;
}

export interface FieldOptionIssue {
  path: string;
  message: string;
}

/**
 * Validate the #751 option keys against the field's type/interface.
 * Returns `[]` when valid. `minLength`/`maxLength` on non-text types are a
 * shape check only (the key predates #751 as a loose Studio hint, so it is
 * ignored rather than rejected there); `allowClear` and `slug` are rejected on
 * fields they cannot apply to.
 */
export function validateFieldOptions(ctx: FieldOptionContext): FieldOptionIssue[] {
  if (ctx.options === undefined || ctx.options === null) return [];
  const parsed = FieldOptionParitySchema.safeParse(ctx.options);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({
      path: ['options', ...i.path.map(String)].join('.'),
      message: i.message,
    }));
  }
  const o = parsed.data;
  const issues: FieldOptionIssue[] = [];
  const isText = (TEXT_LENGTH_FIELD_TYPES as readonly string[]).includes(ctx.type);
  if (o.allowClear !== undefined && !(SINGLE_CHOICE_INTERFACES as readonly string[]).includes(ctx.interface)) {
    issues.push({
      path: 'options.allowClear',
      message: `allowClear applies only to single-choice interfaces (${SINGLE_CHOICE_INTERFACES.join(', ')}).`,
    });
  }
  if (o.slug !== undefined && !isText) {
    issues.push({ path: 'options.slug', message: 'slug policy applies only to string/text fields.' });
  }
  if (isText && o.maxLength !== undefined && typeof ctx.length === 'number' && o.maxLength > ctx.length) {
    issues.push({
      path: 'options.maxLength',
      message: `maxLength (${o.maxLength}) exceeds the field's storage length (${ctx.length}).`,
    });
  }
  return issues;
}
