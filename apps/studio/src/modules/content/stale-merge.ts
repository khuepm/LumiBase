/**
 * Three-way field merge for a save that lost a race (#685).
 *
 * `base` is what the editor loaded, `mine` the draft, `theirs` the version
 * someone else saved since. Per top-level field (the unit the revision engine
 * records):
 * - only I changed it → keep mine;
 * - only they changed it → take theirs;
 * - both changed it to the same value → that value;
 * - both changed it differently → a conflict: mine is kept in the draft and
 *   the field is listed so the editor can review it before saving again.
 */
export interface MergeResult {
  data: Record<string, unknown>;
  /** Fields both sides changed differently (mine kept). */
  conflicts: string[];
  /** Fields updated from the newer version. */
  fromTheirs: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function mergeDrafts(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): MergeResult {
  const keys = Array.from(new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])).sort();
  const data: Record<string, unknown> = {};
  const conflicts: string[] = [];
  const fromTheirs: string[] = [];
  for (const key of keys) {
    const b = base[key];
    const m = mine[key];
    const t = theirs[key];
    const iChanged = !same(m, b);
    const theyChanged = !same(t, b);
    let value: unknown;
    if (!theyChanged) value = m;
    else if (!iChanged) {
      value = t;
      fromTheirs.push(key);
    } else {
      value = m;
      if (!same(m, t)) conflicts.push(key);
    }
    if (value !== undefined) data[key] = value;
  }
  return { data, conflicts, fromTheirs };
}
