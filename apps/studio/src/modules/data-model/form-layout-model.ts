import {
  conditionFields,
  FORM_LAYOUT_VERSION,
  type Condition,
  type ConditionLeaf,
  type ConditionOp,
  type ConditionScalar,
  type FormLayout,
  type LayoutNode,
} from '@lumibase/contracts/form-layout';

/**
 * Pure editing operations for the form-layout builder (#750). Every helper
 * returns a new layout; nothing mutates its input.
 *
 * A node is addressed by a ref: `field:<key>` for a field placement,
 * `node:<id>` for a tab / group / divider.
 */

export type NodeRef = `field:${string}` | `node:${string}`;
export type ContainerType = 'tab' | 'group';

export const emptyLayout = (): FormLayout => ({ version: FORM_LAYOUT_VERSION, nodes: [] });

export function refOf(node: LayoutNode): NodeRef {
  return node.type === 'field' ? `field:${node.field}` : `node:${node.id}`;
}

function matches(node: LayoutNode, ref: NodeRef): boolean {
  return refOf(node) === ref;
}

/** All node ids in use. */
function nodeIds(nodes: LayoutNode[], out = new Set<string>()): Set<string> {
  for (const n of nodes) {
    if (n.type !== 'field') out.add(n.id);
    if (n.type === 'tab' || n.type === 'group') nodeIds(n.children, out);
  }
  return out;
}

export function nextNodeId(layout: FormLayout, prefix: string): string {
  const used = nodeIds(layout.nodes);
  let i = 1;
  while (used.has(`${prefix}-${i}`)) i += 1;
  return `${prefix}-${i}`;
}

export function findNode(nodes: LayoutNode[], ref: NodeRef): LayoutNode | null {
  for (const n of nodes) {
    if (matches(n, ref)) return n;
    if (n.type === 'tab' || n.type === 'group') {
      const hit = findNode(n.children, ref);
      if (hit) return hit;
    }
  }
  return null;
}

/** Remove a node (with its subtree) wherever it is. */
function without(nodes: LayoutNode[], ref: NodeRef): LayoutNode[] {
  const out: LayoutNode[] = [];
  for (const n of nodes) {
    if (matches(n, ref)) continue;
    if (n.type === 'tab' || n.type === 'group') out.push({ ...n, children: without(n.children, ref) });
    else out.push(n);
  }
  return out;
}

/** Append `node` to the container `parentId` (null = top level). */
function appendTo(nodes: LayoutNode[], parentId: string | null, node: LayoutNode): LayoutNode[] {
  if (parentId === null) return [...nodes, node];
  return nodes.map((n) => {
    if (n.type !== 'tab' && n.type !== 'group') return n;
    if (n.id === parentId) return { ...n, children: [...n.children, node] };
    return { ...n, children: appendTo(n.children, parentId, node) };
  });
}

function contains(node: LayoutNode, ref: NodeRef): boolean {
  if (node.type !== 'tab' && node.type !== 'group') return false;
  return node.children.some((c) => matches(c, ref) || contains(c, ref));
}

export function addNode(layout: FormLayout, type: ContainerType | 'divider', parentId: string | null): FormLayout {
  const id = nextNodeId(layout, type);
  const node: LayoutNode =
    type === 'divider'
      ? { type: 'divider', id }
      : type === 'tab'
        ? { type: 'tab', id, label: `Tab ${id.split('-')[1]}`, children: [] }
        : { type: 'group', id, label: `Group ${id.split('-')[1]}`, children: [] };
  return { ...layout, nodes: appendTo(layout.nodes, parentId, node) };
}

/**
 * Place a field into a container (null = top level). An existing placement
 * moves, so a field can never be placed twice.
 */
export function placeField(layout: FormLayout, field: string, parentId: string | null): FormLayout {
  const ref: NodeRef = `field:${field}`;
  const existing = findNode(layout.nodes, ref);
  const node: LayoutNode = existing ?? { type: 'field', field };
  return { ...layout, nodes: appendTo(without(layout.nodes, ref), parentId, node) };
}

/** Move an existing node into a container; refuses to move a container into itself. */
export function moveInto(layout: FormLayout, ref: NodeRef, parentId: string | null): FormLayout {
  const node = findNode(layout.nodes, ref);
  if (!node) return layout;
  if (parentId !== null && (ref === `node:${parentId}` || contains(node, `node:${parentId}`))) return layout;
  return { ...layout, nodes: appendTo(without(layout.nodes, ref), parentId, node) };
}

export function removeNode(layout: FormLayout, ref: NodeRef): FormLayout {
  return { ...layout, nodes: without(layout.nodes, ref) };
}

/** Move a node one step up (-1) or down (+1) among its siblings. */
export function shiftNode(layout: FormLayout, ref: NodeRef, delta: -1 | 1): FormLayout {
  const shift = (nodes: LayoutNode[]): LayoutNode[] => {
    const i = nodes.findIndex((n) => matches(n, ref));
    if (i >= 0) {
      const j = i + delta;
      if (j < 0 || j >= nodes.length) return nodes;
      const next = [...nodes];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    }
    return nodes.map((n) => (n.type === 'tab' || n.type === 'group' ? { ...n, children: shift(n.children) } : n));
  };
  return { ...layout, nodes: shift(layout.nodes) };
}

/** Shallow-merge `patch` into a node; `undefined` values delete the key. */
export function updateNode(layout: FormLayout, ref: NodeRef, patch: Record<string, unknown>): FormLayout {
  const apply = (nodes: LayoutNode[]): LayoutNode[] =>
    nodes.map((n) => {
      if (matches(n, ref)) {
        const next: Record<string, unknown> = { ...n };
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete next[k];
          else next[k] = v;
        }
        return next as unknown as LayoutNode;
      }
      return n.type === 'tab' || n.type === 'group' ? { ...n, children: apply(n.children) } : n;
    });
  return { ...layout, nodes: apply(layout.nodes) };
}

/**
 * Drop placements of fields that no longer exist (deleted since the layout
 * was saved). Conditions reading a deleted field are left for the admin to
 * fix — silently rewriting them would change who sees what.
 */
export function pruneUnknownFields(layout: FormLayout, fieldNames: Iterable<string>): FormLayout {
  const known = new Set(fieldNames);
  const prune = (nodes: LayoutNode[]): LayoutNode[] =>
    nodes
      .filter((n) => n.type !== 'field' || known.has(n.field))
      .map((n) => (n.type === 'tab' || n.type === 'group' ? { ...n, children: prune(n.children) } : n));
  return { ...layout, nodes: prune(layout.nodes) };
}

/** Containers (tabs + groups) in document order, for "place in…" pickers. */
export function containers(nodes: LayoutNode[], depth = 0): Array<{ id: string; label: string; depth: number }> {
  const out: Array<{ id: string; label: string; depth: number }> = [];
  for (const n of nodes) {
    if (n.type === 'tab' || n.type === 'group') {
      out.push({ id: n.id, label: `${n.type === 'tab' ? 'Tab' : 'Group'}: ${n.label ?? n.id}`, depth });
      out.push(...containers(n.children, depth + 1));
    }
  }
  return out;
}

// ---------- Simple condition editing ----------

export interface SimpleCondition {
  match: 'all' | 'any';
  rules: ConditionLeaf[];
}

/**
 * The rule-list form the visual editor handles: one leaf, or an `and`/`or`
 * of leaves. Anything else (`not`, nesting) is edited as JSON; returns null.
 */
export function toSimple(cond: Condition | undefined): SimpleCondition | null {
  if (!cond) return { match: 'all', rules: [] };
  if ('field' in cond) return { match: 'all', rules: [cond] };
  if ('and' in cond && cond.and.every((c) => 'field' in c)) return { match: 'all', rules: cond.and as ConditionLeaf[] };
  if ('or' in cond && cond.or.every((c) => 'field' in c)) return { match: 'any', rules: cond.or as ConditionLeaf[] };
  return null;
}

export function fromSimple(simple: SimpleCondition): Condition | undefined {
  if (simple.rules.length === 0) return undefined;
  if (simple.rules.length === 1) return simple.rules[0];
  return simple.match === 'all' ? { and: simple.rules } : { or: simple.rules };
}

const NUMERIC_TYPES = new Set(['integer', 'bigInteger', 'decimal', 'float']);

/** Parse one typed-in scalar using the target field's storage type. */
export function parseScalar(raw: string, fieldType: string | undefined): ConditionScalar {
  const text = raw.trim();
  if (text === 'null') return null;
  if (fieldType === 'boolean') return text === 'true';
  if (fieldType && NUMERIC_TYPES.has(fieldType)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  return raw;
}

/** Value for an operator from the editor's text box. */
export function parseRuleValue(op: ConditionOp, raw: string, fieldType: string | undefined): ConditionLeaf['value'] {
  if (op === 'empty' || op === 'nempty') return undefined;
  if (op === 'in' || op === 'nin') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => parseScalar(s, fieldType));
  }
  return parseScalar(raw, fieldType);
}

export function formatRuleValue(value: ConditionLeaf['value']): string {
  if (value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  return String(value);
}

/** Field keys any condition in the layout reads. */
export function referencedFields(layout: FormLayout): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: LayoutNode[]) => {
    for (const n of nodes) {
      if (n.visibleWhen) conditionFields(n.visibleWhen, out);
      if (n.type === 'tab' || n.type === 'group') walk(n.children);
    }
  };
  walk(layout.nodes);
  return out;
}
