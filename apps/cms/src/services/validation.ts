import { z, type ZodTypeAny } from 'zod';
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

function buildFieldSchema(field: CompiledField): ZodTypeAny {
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
  options: { partial?: boolean } = {},
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: ValidationIssue[] } {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of compiledFields) {
    if (options.partial && data[f.name] === undefined) continue;
    shape[f.name] = buildFieldSchema(f);
  }
  const schema = z.looseObject(shape);
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };

  return {
    ok: false,
    issues: result.error.issues.map((i) => ({
      field: i.path.join('.'),
      code: i.code,
      message: i.message,
    })),
  };
}
