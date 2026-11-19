/**
 * Field-level diff — shared by the CMS (version compare endpoint) and the
 * Studio `RevisionsDiff` component so both compute changes identically.
 * See `.kiro/specs/content-versioning`.
 *
 * Comparison is shallow over top-level keys: that matches how the revision
 * engine records changes (each top-level field is the unit of change). Nested
 * values are compared by JSON equality.
 */

export type ChangeState = 'added' | 'removed' | 'changed' | 'unchanged';

export interface Change {
  key: string;
  state: ChangeState;
  before: unknown;
  after: unknown;
}

/** Compute per-field changes between two `data` snapshots. */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): Change[] {
  const b = before ?? {};
  const a = after ?? {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)])).sort();
  return keys.map((key): Change => {
    const inB = key in b;
    const inA = key in a;
    const bv = b[key];
    const av = a[key];
    if (inB && !inA) return { key, state: 'removed', before: bv, after: undefined };
    if (!inB && inA) return { key, state: 'added', before: undefined, after: av };
    if (JSON.stringify(bv) === JSON.stringify(av))
      return { key, state: 'unchanged', before: bv, after: av };
    return { key, state: 'changed', before: bv, after: av };
  });
}

// ---------------------------------------------------------------------------
// Field-aware diffs (#686): word diff for text, path diff for JSON, set diff
// for lists. Shared by the CMS compare endpoint and the Studio diff view.
// ---------------------------------------------------------------------------

export type TokenOp = 'equal' | 'insert' | 'delete';

export interface DiffToken {
  op: TokenOp;
  text: string;
}

/** Above this many tokens per side the LCS table gets large; fall back to a block replace. */
export const WORD_DIFF_MAX_TOKENS = 2000;

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/**
 * Word-level diff (whitespace kept as its own tokens) by longest common
 * subsequence. Adjacent tokens with the same op are merged. Inputs larger
 * than {@link WORD_DIFF_MAX_TOKENS} tokens per side diff as one delete + one
 * insert, so the cost stays bounded.
 */
export function wordDiff(before: string, after: string): DiffToken[] {
  if (before === after) return before ? [{ op: 'equal', text: before }] : [];
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > WORD_DIFF_MAX_TOKENS || b.length > WORD_DIFF_MAX_TOKENS) {
    return merge([
      ...(before ? [{ op: 'delete' as const, text: before }] : []),
      ...(after ? [{ op: 'insert' as const, text: after }] : []),
    ]);
  }
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..], as one flat array.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    }
  }
  const out: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'equal', text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
      out.push({ op: 'delete', text: a[i]! });
      i += 1;
    } else {
      out.push({ op: 'insert', text: b[j]! });
      j += 1;
    }
  }
  while (i < n) out.push({ op: 'delete', text: a[i++]! });
  while (j < m) out.push({ op: 'insert', text: b[j++]! });
  return merge(out);
}

function merge(tokens: DiffToken[]): DiffToken[] {
  const out: DiffToken[] = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (last && last.op === t.op) last.text += t.text;
    else out.push({ ...t });
  }
  return out;
}

export interface PathChange {
  /** Dotted path, array indices as numbers: `seo.title`, `blocks.2.data`. */
  path: string;
  state: Exclude<ChangeState, 'unchanged'>;
  before: unknown;
  after: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Leaf-level differences between two JSON values: objects and arrays are
 * walked, everything else compared by JSON equality. `depth` caps the walk;
 * below it a whole subtree reports as one change.
 */
export function jsonPathDiff(before: unknown, after: unknown, depth = 8, prefix = ''): PathChange[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const walkable = (v: unknown) => isPlainObject(v) || Array.isArray(v);
  if (depth <= 0 || !walkable(before) || !walkable(after) || Array.isArray(before) !== Array.isArray(after)) {
    const state: PathChange['state'] = before === undefined ? 'added' : after === undefined ? 'removed' : 'changed';
    return [{ path: prefix, state, before, after }];
  }
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
  if (!Array.isArray(before)) keys.sort();
  const out: PathChange[] = [];
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(...jsonPathDiff(key in b ? b[key] : undefined, key in a ? a[key] : undefined, depth - 1, path));
  }
  return out;
}

export interface ListDiff {
  added: unknown[];
  removed: unknown[];
  kept: unknown[];
  /** Same members, different order. */
  reordered: boolean;
}

/** Set-style diff of two lists (relation id lists, tags), compared by JSON value. */
export function listDiff(before: readonly unknown[], after: readonly unknown[]): ListDiff {
  const key = (v: unknown) => JSON.stringify(v);
  const bKeys = before.map(key);
  const aKeys = after.map(key);
  const bSet = new Set(bKeys);
  const aSet = new Set(aKeys);
  const kept = after.filter((v) => bSet.has(key(v)));
  const keptBefore = before.filter((v) => aSet.has(key(v)));
  return {
    added: after.filter((v) => !bSet.has(key(v))),
    removed: before.filter((v) => !aSet.has(key(v))),
    kept,
    reordered: JSON.stringify(kept) !== JSON.stringify(keptBefore),
  };
}

/** How a value is best diffed. */
export type DiffKind = 'text' | 'list' | 'json' | 'scalar';

export function diffKindOf(before: unknown, after: unknown): DiffKind {
  const v = before ?? after;
  const w = after ?? before;
  if (typeof v === 'string' && typeof w === 'string') return 'text';
  const primitiveList = (x: unknown) =>
    Array.isArray(x) && x.every((e) => e === null || ['string', 'number', 'boolean'].includes(typeof e));
  if (primitiveList(v) && primitiveList(w)) return 'list';
  if ((isPlainObject(v) || Array.isArray(v)) && (isPlainObject(w) || Array.isArray(w))) return 'json';
  return 'scalar';
}
