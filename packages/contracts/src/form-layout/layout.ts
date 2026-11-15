import { z } from 'zod';
import {
  conditionFields,
  conditionSchema,
  conditionStats,
  evaluateCondition,
  FIELD_KEY_PATTERN,
  MAX_CONDITION_DEPTH,
  MAX_CONDITION_NODES,
  type Condition,
} from './condition';

/**
 * Collection form layout (#750): a tree of tabs, groups and dividers that
 * places fields by key. Stored at `collection.meta.formLayout`; no migration.
 *
 * - Every field appears at most once. Fields the layout does not place render
 *   in a default section, so a collection without a layout (or with an empty
 *   one) renders exactly as before.
 * - Consecutive `tab` siblings form one tab strip.
 * - `visibleWhen` on any node hides that node (and everything under it) when
 *   the condition is false for the item's current values.
 * - `skipRequiredWhenHidden` (default false) lets a hidden field skip the
 *   required check; without it a hidden required field is still required.
 * - `hiddenValue` (default `keep`) decides what saving does to a hidden
 *   field's stale value: `keep` stores it untouched, `clear` removes it.
 *   Both flags inherit from the nearest ancestor that sets them.
 */

export const FORM_LAYOUT_VERSION = 1 as const;
/** Maximum container nesting (tab/group inside tab/group …). */
export const MAX_LAYOUT_DEPTH = 6;
/** Maximum total nodes in one layout. */
export const MAX_LAYOUT_NODES = 500;
export const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export type HiddenValuePolicy = 'keep' | 'clear';

export interface VisibilityOptions {
  visibleWhen?: Condition;
  skipRequiredWhenHidden?: boolean;
  hiddenValue?: HiddenValuePolicy;
}

export interface LayoutFieldNode extends VisibilityOptions {
  type: 'field';
  field: string;
}
export interface LayoutTabNode extends VisibilityOptions {
  type: 'tab';
  id: string;
  label: string;
  children: LayoutNode[];
}
export interface LayoutGroupNode extends VisibilityOptions {
  type: 'group';
  id: string;
  label?: string;
  /** Renders a disclosure button; `collapsed` is the initial state. */
  collapsible?: boolean;
  collapsed?: boolean;
  children: LayoutNode[];
}
export interface LayoutDividerNode {
  type: 'divider';
  id: string;
  label?: string;
  visibleWhen?: Condition;
}
export type LayoutNode = LayoutFieldNode | LayoutTabNode | LayoutGroupNode | LayoutDividerNode;
export type LayoutContainerNode = LayoutTabNode | LayoutGroupNode;

export interface FormLayout {
  version: typeof FORM_LAYOUT_VERSION;
  nodes: LayoutNode[];
}

const visibility = {
  visibleWhen: conditionSchema.optional(),
  skipRequiredWhenHidden: z.boolean().optional(),
  hiddenValue: z.enum(['keep', 'clear']).optional(),
};
const nodeId = z.string().regex(NODE_ID_PATTERN, 'Node id must be lowercase letters, digits, "-" or "_".');
const label = z.string().trim().min(1).max(120);

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z
      .object({
        type: z.literal('field'),
        field: z.string().regex(FIELD_KEY_PATTERN, 'Field key must be a field name.'),
        ...visibility,
      })
      .strict(),
    z
      .object({
        type: z.literal('tab'),
        id: nodeId,
        label,
        children: z.array(layoutNodeSchema),
        ...visibility,
      })
      .strict(),
    z
      .object({
        type: z.literal('group'),
        id: nodeId,
        label: label.optional(),
        collapsible: z.boolean().optional(),
        collapsed: z.boolean().optional(),
        children: z.array(layoutNodeSchema),
        ...visibility,
      })
      .strict(),
    z
      .object({
        type: z.literal('divider'),
        id: nodeId,
        label: label.optional(),
        visibleWhen: conditionSchema.optional(),
      })
      .strict(),
  ]),
) as z.ZodType<LayoutNode>;

export const formLayoutSchema = z
  .object({
    version: z.literal(FORM_LAYOUT_VERSION),
    nodes: z.array(layoutNodeSchema),
  })
  .strict() as z.ZodType<FormLayout>;

export interface FormLayoutIssue {
  path: string;
  code:
    | 'SCHEMA'
    | 'DUPLICATE_FIELD'
    | 'UNKNOWN_FIELD'
    | 'DUPLICATE_NODE_ID'
    | 'UNKNOWN_CONDITION_FIELD'
    | 'SELF_REFERENCE'
    | 'TOO_DEEP'
    | 'TOO_MANY_NODES'
    | 'CONDITION_TOO_COMPLEX';
  message: string;
}

export type FormLayoutResult = { ok: true; layout: FormLayout } | { ok: false; issues: FormLayoutIssue[] };

/**
 * Full validation of a candidate layout: Zod structure, then the tree rules
 * Zod cannot express — every field placed at most once, every placed or
 * referenced key is a real field, node ids unique, depth/size bounded, no
 * field conditioned on its own value.
 */
export function validateFormLayout(input: unknown, fieldNames: Iterable<string>): FormLayoutResult {
  const parsed = formLayoutSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.'), code: 'SCHEMA', message: i.message })),
    };
  }
  const known = new Set(fieldNames);
  const issues: FormLayoutIssue[] = [];
  const placed = new Set<string>();
  const ids = new Set<string>();
  let count = 0;

  const checkCondition = (cond: Condition | undefined, path: string, self?: string) => {
    if (!cond) return;
    const stats = conditionStats(cond);
    if (stats.depth > MAX_CONDITION_DEPTH || stats.nodes > MAX_CONDITION_NODES) {
      issues.push({
        path: `${path}.visibleWhen`,
        code: 'CONDITION_TOO_COMPLEX',
        message: `Condition exceeds ${MAX_CONDITION_DEPTH} levels or ${MAX_CONDITION_NODES} nodes.`,
      });
    }
    for (const key of conditionFields(cond)) {
      if (!known.has(key)) {
        issues.push({ path: `${path}.visibleWhen`, code: 'UNKNOWN_CONDITION_FIELD', message: `Condition reads unknown field "${key}".` });
      }
      if (self && key === self) {
        issues.push({
          path: `${path}.visibleWhen`,
          code: 'SELF_REFERENCE',
          message: `Field "${self}" cannot be shown or hidden by its own value.`,
        });
      }
    }
  };

  const walk = (nodes: LayoutNode[], path: string, depth: number) => {
    nodes.forEach((node, index) => {
      const at = `${path}.${index}`;
      count += 1;
      if (node.type === 'field') {
        if (!known.has(node.field)) {
          issues.push({ path: `${at}.field`, code: 'UNKNOWN_FIELD', message: `Unknown field "${node.field}".` });
        }
        if (placed.has(node.field)) {
          issues.push({ path: `${at}.field`, code: 'DUPLICATE_FIELD', message: `Field "${node.field}" is placed more than once.` });
        }
        placed.add(node.field);
        checkCondition(node.visibleWhen, at, node.field);
        return;
      }
      if (ids.has(node.id)) {
        issues.push({ path: `${at}.id`, code: 'DUPLICATE_NODE_ID', message: `Node id "${node.id}" is used more than once.` });
      }
      ids.add(node.id);
      checkCondition(node.visibleWhen, at);
      if (node.type === 'divider') return;
      if (depth + 1 > MAX_LAYOUT_DEPTH) {
        issues.push({ path: at, code: 'TOO_DEEP', message: `Layout nests deeper than ${MAX_LAYOUT_DEPTH} levels.` });
        return;
      }
      walk(node.children, `${at}.children`, depth + 1);
    });
  };
  walk(parsed.data.nodes, 'nodes', 0);
  if (count > MAX_LAYOUT_NODES) {
    issues.push({ path: 'nodes', code: 'TOO_MANY_NODES', message: `Layout has more than ${MAX_LAYOUT_NODES} nodes.` });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, layout: parsed.data };
}

/**
 * Lenient read of a stored layout (`collection.meta.formLayout`). Returns
 * `null` for "no layout" and for anything that does not parse — a broken
 * layout is ignored rather than trusted, so every field falls back to the
 * default section and required rules apply in full (fail closed).
 */
export function parseFormLayout(raw: unknown): FormLayout | null {
  if (raw === undefined || raw === null) return null;
  const parsed = formLayoutSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface FieldVisibility {
  /** Hidden by its own `visibleWhen` or by an ancestor's. */
  hidden: boolean;
  /** Effective `skipRequiredWhenHidden` (nearest explicit setting, default false). */
  skipRequiredWhenHidden: boolean;
  /** Effective `hiddenValue` (nearest explicit setting, default `keep`). */
  hiddenValue: HiddenValuePolicy;
}

export interface FormVisibility {
  /** Placed fields only; unplaced fields are always visible. */
  fields: Map<string, FieldVisibility>;
  /** Ids of tab/group/divider nodes hidden by a condition (own or inherited). */
  hiddenNodes: Set<string>;
}

/** Resolve visibility of every node for the given item values. */
export function resolveFormVisibility(
  layout: FormLayout | null,
  data: Readonly<Record<string, unknown>>,
): FormVisibility {
  const result: FormVisibility = { fields: new Map(), hiddenNodes: new Set() };
  if (!layout) return result;
  const visit = (
    nodes: LayoutNode[],
    parentHidden: boolean,
    inheritedSkip: boolean | undefined,
    inheritedPolicy: HiddenValuePolicy | undefined,
    depth: number,
  ) => {
    if (depth > MAX_LAYOUT_DEPTH + 1) return;
    for (const node of nodes) {
      const hidden = parentHidden || (node.visibleWhen ? !evaluateCondition(node.visibleWhen, data) : false);
      if (node.type === 'divider') {
        if (hidden) result.hiddenNodes.add(node.id);
        continue;
      }
      const skip = node.skipRequiredWhenHidden ?? inheritedSkip;
      const policy = node.hiddenValue ?? inheritedPolicy;
      if (node.type === 'field') {
        if (result.fields.has(node.field)) continue; // first placement wins
        result.fields.set(node.field, {
          hidden,
          skipRequiredWhenHidden: skip ?? false,
          hiddenValue: policy ?? 'keep',
        });
        continue;
      }
      if (hidden) result.hiddenNodes.add(node.id);
      visit(node.children, hidden, skip, policy, depth + 1);
    }
  };
  visit(layout.nodes, false, undefined, undefined, 0);
  return result;
}

/** Field keys the layout places (in document order). */
export function placedFields(layout: FormLayout | null): string[] {
  const out: string[] = [];
  if (!layout) return out;
  const walk = (nodes: LayoutNode[]) => {
    for (const node of nodes) {
      if (node.type === 'field') out.push(node.field);
      else if (node.type !== 'divider') walk(node.children);
    }
  };
  walk(layout.nodes);
  return out;
}

/** Fields that are hidden by a condition AND configured to skip required. */
export function requiredSkippedFields(visibility: FormVisibility): Set<string> {
  const out = new Set<string>();
  for (const [key, v] of visibility.fields) {
    if (v.hidden && v.skipRequiredWhenHidden) out.add(key);
  }
  return out;
}

export interface RequiredFieldLike {
  name: string;
  required: boolean;
}

/**
 * The required rule shared by Studio and CMS: a required field is missing
 * when its value is `undefined` or `null`, unless it is hidden by a condition
 * and configured `skipRequiredWhenHidden`. With `partial` (a PATCH), only
 * keys present in `data` are checked — mirroring the server's partial
 * validation. `context` is the full record conditions are evaluated against
 * (defaults to `data`).
 */
export function missingRequiredFields(
  fields: readonly RequiredFieldLike[],
  data: Readonly<Record<string, unknown>>,
  layout: FormLayout | null,
  options: { partial?: boolean; context?: Readonly<Record<string, unknown>> } = {},
): string[] {
  const skipped = requiredSkippedFields(resolveFormVisibility(layout, options.context ?? data));
  const missing: string[] = [];
  for (const f of fields) {
    if (!f.required || skipped.has(f.name)) continue;
    const present = Object.prototype.hasOwnProperty.call(data, f.name);
    if (options.partial && (!present || data[f.name] === undefined)) continue;
    const v = present ? data[f.name] : undefined;
    if (v === undefined || v === null) missing.push(f.name);
  }
  return missing;
}

/**
 * Keys whose stale value a save should drop: hidden by a condition with the
 * `clear` policy. A field the required rule still demands (required and not
 * skipping) is never cleared, so clearing can't break validation.
 */
export function fieldsToClear(
  fields: readonly RequiredFieldLike[],
  visibility: FormVisibility,
): string[] {
  const required = new Map(fields.map((f) => [f.name, f.required] as const));
  const out: string[] = [];
  for (const [key, v] of visibility.fields) {
    if (!v.hidden || v.hiddenValue !== 'clear') continue;
    if (!required.has(key)) continue;
    if (required.get(key) && !v.skipRequiredWhenHidden) continue;
    out.push(key);
  }
  return out;
}

function renameInCondition(cond: Condition, from: string, to: string): Condition {
  if ('and' in cond) return { and: cond.and.map((c) => renameInCondition(c, from, to)) };
  if ('or' in cond) return { or: cond.or.map((c) => renameInCondition(c, from, to)) };
  if ('not' in cond) return { not: renameInCondition(cond.not, from, to) };
  return cond.field === from ? { ...cond, field: to } : cond;
}

/** Rewrite every placement of, and condition reference to, `from` as `to`. */
export function renameFieldInLayout(layout: FormLayout, from: string, to: string): FormLayout {
  const mapNode = (node: LayoutNode): LayoutNode => {
    const withCond = node.visibleWhen ? { visibleWhen: renameInCondition(node.visibleWhen, from, to) } : {};
    if (node.type === 'field') return { ...node, ...withCond, field: node.field === from ? to : node.field };
    if (node.type === 'divider') return { ...node, ...withCond };
    return { ...node, ...withCond, children: node.children.map(mapNode) };
  };
  return { version: layout.version, nodes: layout.nodes.map(mapNode) };
}

/** Drop the keys `fieldsToClear` names; returns a new object. */
export function applyHiddenValuePolicy(
  fields: readonly RequiredFieldLike[],
  data: Readonly<Record<string, unknown>>,
  layout: FormLayout | null,
): { data: Record<string, unknown>; cleared: string[] } {
  if (!layout) return { data: { ...data }, cleared: [] };
  const cleared = fieldsToClear(fields, resolveFormVisibility(layout, data)).filter((k) =>
    Object.prototype.hasOwnProperty.call(data, k),
  );
  if (cleared.length === 0) return { data: { ...data }, cleared };
  const next: Record<string, unknown> = { ...data };
  for (const key of cleared) delete next[key];
  return { data: next, cleared };
}
