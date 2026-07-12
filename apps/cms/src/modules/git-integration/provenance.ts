/**
 * Provenance — links a commit / PR to the content, schema, or intent change it
 * produced, so operators can answer "which commit/PR changed this item?".
 */
import type { Database } from '@lumibase/database';
import { gitProvenance } from '@lumibase/database';
import { and, desc, eq } from 'drizzle-orm';

export type ProvenanceChangeType = 'content' | 'schema' | 'intent';

export interface ProvenanceInput {
  siteId: string;
  integrationId?: string | null;
  commitSha: string;
  prNumber?: number | null;
  collection?: string | null;
  itemId?: string | null;
  changeType: ProvenanceChangeType;
}

export async function recordProvenance(
  db: Database,
  input: ProvenanceInput,
): Promise<void> {
  await db.insert(gitProvenance).values({
    siteId: input.siteId,
    integrationId: input.integrationId ?? null,
    commitSha: input.commitSha,
    prNumber: input.prNumber ?? null,
    collection: input.collection ?? null,
    itemId: input.itemId ?? null,
    changeType: input.changeType,
  });
}

export interface ProvenanceQuery {
  siteId: string;
  integrationId?: string;
  collection?: string;
  itemId?: string;
  limit?: number;
}

export async function queryProvenance(
  db: Database,
  q: ProvenanceQuery,
): Promise<(typeof gitProvenance.$inferSelect)[]> {
  const filters = [eq(gitProvenance.siteId, q.siteId)];
  if (q.integrationId)
    filters.push(eq(gitProvenance.integrationId, q.integrationId));
  if (q.collection) filters.push(eq(gitProvenance.collection, q.collection));
  if (q.itemId) filters.push(eq(gitProvenance.itemId, q.itemId));
  return db
    .select()
    .from(gitProvenance)
    .where(and(...filters))
    .orderBy(desc(gitProvenance.createdAt))
    .limit(Math.min(q.limit ?? 100, 500));
}
