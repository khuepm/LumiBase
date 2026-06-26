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
