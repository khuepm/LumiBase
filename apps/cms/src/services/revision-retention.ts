/**
 * Revision retention (#693).
 *
 * A collection opts in with `meta.revisionRetention`:
 *
 * ```json
 * { "revisionRetention": { "maxRevisions": 50, "maxAgeDays": 90 } }
 * ```
 *
 * The hourly sweep deletes, per item, revisions beyond the newest
 * `maxRevisions` and revisions older than `maxAgeDays`. Some rows are never
 * pruned, whatever the policy says:
 *
 * - the newest revision of every item (the item always has a history head);
 * - staged revisions (an L3 veto window is still open on them);
 * - revisions a release pins (`release_items.revision_id`);
 * - agent-authored revisions — they are the provenance record of an agent
 *   write, and stay under the audit retention instead.
 *
 * The sweep is idempotent and safe under overlap: each pass recomputes the
 * set from the table and a second concurrent DELETE simply finds fewer rows.
 */
import { sql } from 'drizzle-orm';
import { collections, type Database } from '@lumibase/database';
import { AuditLogger } from '../modules/audit/logger';

export interface RevisionRetentionPolicy {
  maxRevisions?: number;
  maxAgeDays?: number;
}

/** Parse `meta.revisionRetention`; `null` when absent or meaningless. */
export function parseRevisionRetention(meta: unknown): RevisionRetentionPolicy | null {
  if (!meta || typeof meta !== 'object') return null;
  const raw = (meta as Record<string, unknown>).revisionRetention;
  if (!raw || typeof raw !== 'object') return null;
  const { maxRevisions, maxAgeDays } = raw as Record<string, unknown>;
  const policy: RevisionRetentionPolicy = {};
  if (typeof maxRevisions === 'number' && Number.isInteger(maxRevisions) && maxRevisions >= 1) {
    policy.maxRevisions = maxRevisions;
  }
  if (typeof maxAgeDays === 'number' && Number.isFinite(maxAgeDays) && maxAgeDays > 0) {
    policy.maxAgeDays = maxAgeDays;
  }
  return policy.maxRevisions === undefined && policy.maxAgeDays === undefined ? null : policy;
}

export interface RevisionRetentionDeps {
  db: Database;
}

/** Prune one collection; returns the number of revisions deleted. */
export async function pruneCollectionRevisions(
  db: Database,
  siteId: string,
  collectionId: string,
  policy: RevisionRetentionPolicy,
  now: Date = new Date(),
): Promise<number> {
  const maxRevisions = policy.maxRevisions ?? null;
  const cutoff = policy.maxAgeDays !== undefined
    ? new Date(now.getTime() - policy.maxAgeDays * 86_400_000).toISOString()
    : null;
  const result = await db.execute(sql`
    DELETE FROM lumibase_revisions r
     USING (
       SELECT id, created_at,
              row_number() OVER (PARTITION BY item_id ORDER BY created_at DESC, id DESC) AS rn
         FROM lumibase_revisions
        WHERE site_id = ${siteId}
          AND collection_id = ${collectionId}
     ) ranked
     WHERE r.id = ranked.id
       AND r.site_id = ${siteId}
       AND r.collection_id = ${collectionId}
       AND ranked.rn > 1
       AND r.staged = false
       AND r.author_type <> 'agent'
       AND NOT EXISTS (
         SELECT 1 FROM lumibase_release_items ri
          WHERE ri.site_id = r.site_id AND ri.revision_id = r.id
       )
       AND (
         (${maxRevisions}::int IS NOT NULL AND ranked.rn > ${maxRevisions}::int)
         OR (${cutoff}::timestamp IS NOT NULL AND ranked.created_at < ${cutoff}::timestamp)
       )
     RETURNING r.id
  `);
  return rowCount(result);
}

function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  const r = result as { rows?: unknown[]; rowCount?: number | null; count?: number };
  if (Array.isArray(r.rows)) return r.rows.length;
  return r.rowCount ?? r.count ?? 0;
}

/**
 * Sweep every collection that declares `meta.revisionRetention`, across all
 * sites. Each collection that loses rows writes one `revision_retention_applied`
 * audit event.
 */
export async function sweepRevisionRetention(
  deps: RevisionRetentionDeps,
  now: Date = new Date(),
): Promise<number> {
  const rows = await deps.db
    .select({ id: collections.id, siteId: collections.siteId, name: collections.name, meta: collections.meta })
    .from(collections)
    // jsonb_exists, not `?`: the operator collides with the driver's placeholder.
    .where(sql`jsonb_exists(${collections.meta}, 'revisionRetention')`);
  let pruned = 0;
  for (const coll of rows) {
    const policy = parseRevisionRetention(coll.meta);
    if (!policy) continue;
    const count = await pruneCollectionRevisions(deps.db, coll.siteId, coll.id, policy, now);
    if (count > 0) {
      await new AuditLogger({ db: deps.db, siteId: coll.siteId }).write({
        event: 'revision_retention_applied',
        requestId: null,
        metadata: { siteId: coll.siteId, collection: coll.name, pruned: count, policy },
      });
      pruned += count;
    }
  }
  return pruned;
}
