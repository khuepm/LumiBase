import { z } from 'zod';

/**
 * Form-layout condition language (#750).
 *
 * A small, declarative, data-only expression tree evaluated against the
 * values of sibling fields on the same item. It is interpreted by a plain
 * `switch` — there is no `eval`, no `Function`, no regex compiled from user
 * input and no property lookup outside the item's own keys — so a stored
 * condition can never execute code. The SAME `evaluateCondition` runs in the
 * Studio (show/hide) and in the CMS (required-validation skip, hidden-value
 * policy), which is what keeps the two sides in agreement.
 *
 *   { field: 'type', op: 'eq', value: 'video' }
 *   { and: [{ field: 'type', op: 'in', value: ['video', 'audio'] },
 *           { not: { field: 'url', op: 'empty' } }] }
 */

export const CONDITION_OPS = [
  'eq',
  'neq',
  'in',
  'nin',
  'empty',
  'nempty',
  'gt',
  'lt',
  'gte',
  'lte',
  'contains',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type ConditionScalar = string | number | boolean | null;
export type ConditionValue = ConditionScalar | ConditionScalar[];

export interface ConditionLeaf {
  field: string;
  op: ConditionOp;
  value?: ConditionValue;
}
export interface ConditionAnd {
  and: Condition[];
}
export interface ConditionOr {
  or: Condition[];
}
export interface ConditionNot {
  not: Condition;
}
export type Condition = ConditionLeaf | ConditionAnd | ConditionOr | ConditionNot;

/** Nesting depth limit (a leaf at the root is depth 1). */
export const MAX_CONDITION_DEPTH = 8;
/** Total node limit per condition tree (leaves + combinators). */
export const MAX_CONDITION_NODES = 64;
/** Field keys follow the field-name rule used by the schema API. */
export const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

const scalarSchema = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);

const leafSchema = z
  .object({
    field: z.string().regex(FIELD_KEY_PATTERN, 'Condition field must be a field key.'),
    op: z.enum(CONDITION_OPS),
    value: z.union([scalarSchema, z.array(scalarSchema).max(100)]).optional(),
  })
  .strict()
  .superRefine((leaf, ctx) => {
    const v = leaf.value;
    switch (leaf.op) {
      case 'empty':
      case 'nempty':
        if (v !== undefined) ctx.addIssue({ code: 'custom', message: `"${leaf.op}" takes no value.` });
        return;
      case 'in':
      case 'nin':
        if (!Array.isArray(v)) ctx.addIssue({ code: 'custom', message: `"${leaf.op}" needs an array value.` });
        return;
      case 'gt':
      case 'lt':
      case 'gte':
      case 'lte':
        if (typeof v !== 'number' && typeof v !== 'string') {
          ctx.addIssue({ code: 'custom', message: `"${leaf.op}" needs a number or string value.` });
        }
        return;
      default:
        // eq / neq / contains compare against one scalar.
        if (v === undefined || Array.isArray(v)) {
          ctx.addIssue({ code: 'custom', message: `"${leaf.op}" needs a single value.` });
        }
    }
  });

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    leafSchema,
    z.object({ and: z.array(conditionSchema).min(1).max(MAX_CONDITION_NODES) }).strict(),
    z.object({ or: z.array(conditionSchema).min(1).max(MAX_CONDITION_NODES) }).strict(),
    z.object({ not: conditionSchema }).strict(),
  ]),
) as z.ZodType<Condition>;

/** Depth + node count of a (structurally valid) condition tree. */
export function conditionStats(cond: Condition): { depth: number; nodes: number } {
  if ('and' in cond || 'or' in cond) {
    const children = 'and' in cond ? cond.and : cond.or;
    let depth = 0;
    let nodes = 1;
    for (const child of children) {
      const s = conditionStats(child);
      depth = Math.max(depth, s.depth);
      nodes += s.nodes;
    }
    return { depth: depth + 1, nodes };
  }
  if ('not' in cond) {
    const s = conditionStats(cond.not);
    return { depth: s.depth + 1, nodes: s.nodes + 1 };
  }
  return { depth: 1, nodes: 1 };
}

/** Field keys a condition reads. */
export function conditionFields(cond: Condition, out: Set<string> = new Set()): Set<string> {
  if ('and' in cond) for (const c of cond.and) conditionFields(c, out);
  else if ('or' in cond) for (const c of cond.or) conditionFields(c, out);
  else if ('not' in cond) conditionFields(cond.not, out);
  else out.add(cond.field);
  return out;
}

/** Own-property read: never walks the prototype chain (`__proto__`, `constructor`). */
function readField(data: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
}

/** Scalar equality; `undefined` (unset) equals `null`. Objects never match. */
function scalarEqual(a: unknown, b: unknown): boolean {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  if (x === null || y === null) return x === y;
  if (typeof x === 'object' || typeof y === 'object') return false;
  return x === y;
}

/** Unset, `null`, `''`, `[]` and `{}` count as empty. `0` and `false` do not. */
export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function compareOrdered(op: 'gt' | 'lt' | 'gte' | 'lte', v: unknown, ref: unknown): boolean {
  const numeric = typeof v === 'number' && typeof ref === 'number' && Number.isFinite(v) && Number.isFinite(ref);
  const textual = typeof v === 'string' && typeof ref === 'string';
  if (!numeric && !textual) return false;
  const a = v as number | string;
  const b = ref as number | string;
  switch (op) {
    case 'gt':
      return a > b;
    case 'lt':
      return a < b;
    case 'gte':
      return a >= b;
    case 'lte':
      return a <= b;
  }
}

function evaluateLeaf(leaf: ConditionLeaf, data: Readonly<Record<string, unknown>>): boolean {
  const v = readField(data, leaf.field);
  const ref = leaf.value;
  switch (leaf.op) {
    case 'eq':
      return scalarEqual(v, ref);
    case 'neq':
      return !scalarEqual(v, ref);
    case 'in':
    case 'nin': {
      if (!Array.isArray(ref)) return false;
      // A multi-value field matches when any of its values is in the list.
      const hit = Array.isArray(v)
        ? v.some((item) => ref.some((r) => scalarEqual(item, r)))
        : ref.some((r) => scalarEqual(v, r));
      return leaf.op === 'in' ? hit : !hit;
    }
    case 'empty':
      return isEmptyValue(v);
    case 'nempty':
      return !isEmptyValue(v);
    case 'gt':
    case 'lt':
    case 'gte':
    case 'lte':
      return compareOrdered(leaf.op, v, ref);
    case 'contains':
      if (Array.isArray(v)) return v.some((item) => scalarEqual(item, ref));
      if (typeof v === 'string' && typeof ref === 'string') return v.includes(ref);
      return false;
    default:
      return false;
  }
}

/**
 * Evaluate a condition against an item's field values. Total: any malformed
 * node, unknown operator or excessive nesting evaluates to `false` instead of
 * throwing. Stored layouts are validated with `conditionSchema` first, so in
 * practice only well-formed trees reach here.
 */
export function evaluateCondition(
  cond: Condition,
  data: Readonly<Record<string, unknown>>,
  depth = 1,
): boolean {
  if (depth > MAX_CONDITION_DEPTH || cond === null || typeof cond !== 'object') return false;
  if ('and' in cond) {
    return Array.isArray(cond.and) && cond.and.length > 0 && cond.and.every((c) => evaluateCondition(c, data, depth + 1));
  }
  if ('or' in cond) {
    return Array.isArray(cond.or) && cond.or.some((c) => evaluateCondition(c, data, depth + 1));
  }
  if ('not' in cond) {
    if (cond.not === null || typeof cond.not !== 'object') return false;
    return !evaluateCondition(cond.not, data, depth + 1);
  }
  if (typeof (cond as ConditionLeaf).field !== 'string') return false;
  return evaluateLeaf(cond as ConditionLeaf, data);
}
