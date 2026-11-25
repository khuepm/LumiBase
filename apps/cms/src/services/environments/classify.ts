/**
 * Content_Promote classification (#853 task 7.1, design §8.1).
 *
 * Decides, per item, what a one-way promote does. All hashes are of snapshots
 * in the ORIGIN id space (`base.ts`), so "same hash" means "same content".
 *
 * | Origin vs Base | Env vs Base | Action        |
 * |----------------|-------------|---------------|
 * | =              | =           | unchanged     |
 * | =              | ≠           | promote       |
 * | ≠              | =           | origin-only   |
 * | ≠              | ≠           | conflict (or unchanged when both reached the same content) |
 * | —              | no lineage  | create        |
 * | = (present)    | deleted     | delete        |
 *
 * Pure: no I/O, so the table is property-testable.
 */

export type PromoteAction = 'unchanged' | 'promote' | 'origin-only' | 'conflict' | 'create' | 'delete' | 'skip';

export interface ClassifyInput {
  /** Lineage of the item; null = created in the environment after the fork, never promoted. */
  lineage: { baseHash: string | null; external: boolean } | null;
  /** Origin row with the same id; null = absent or soft-deleted. */
  origin: { hash: string } | null;
  /** Environment row; `deleted` = soft-deleted in the environment. */
  env: { hash: string; deleted: boolean };
}

export interface Classification {
  action: PromoteAction;
  /** Machine-readable reason for `conflict` / `skip`. */
  reason?: string;
}

export function classify(input: ClassifyInput): Classification {
  const { lineage, origin, env } = input;

  if (!lineage) {
    if (env.deleted) return { action: 'skip', reason: 'CREATED_AND_DELETED_IN_ENVIRONMENT' };
    // Same id already in the origin: a caller-chosen key the origin took after the fork.
    if (origin) return { action: 'conflict', reason: 'ITEM_ID_EXISTS' };
    return { action: 'create' };
  }
  if (lineage.external) return { action: 'skip', reason: 'EXTERNAL_REFERENCE' };

  const base = lineage.baseHash;
  // No base (should not happen for a forked item): never guess, never overwrite.
  if (!base) return origin && origin.hash === env.hash ? { action: 'unchanged' } : { action: 'conflict', reason: 'BASE_MISSING' };

  if (env.deleted) {
    if (!origin) return { action: 'unchanged' };
    return origin.hash === base ? { action: 'delete' } : { action: 'conflict', reason: 'ORIGIN_CHANGED' };
  }

  const envChanged = env.hash !== base;
  if (!origin) {
    return envChanged ? { action: 'conflict', reason: 'ORIGIN_DELETED' } : { action: 'origin-only' };
  }
  const originChanged = origin.hash !== base;
  if (!originChanged && !envChanged) return { action: 'unchanged' };
  if (!originChanged) return { action: 'promote' };
  if (!envChanged) return { action: 'origin-only' };
  if (origin.hash === env.hash) return { action: 'unchanged' };
  return { action: 'conflict', reason: 'ORIGIN_CHANGED' };
}
