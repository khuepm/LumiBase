/**
 * Merge lock (#853 task 7.6, design §10.1, Req 10.1).
 *
 * A promote moves the environment `ready → merging` with a conditional UPDATE
 * that also requires no sibling environment of the same origin to be merging.
 * No advisory lock, so it works through Hyperdrive and transaction pooling.
 * The lock lives on the origin's own rows (`lumibase_environments.site_id`),
 * so the request connection scoped to the origin can take and drop it.
 *
 * A crashed promote leaves `merging` behind; it is taken over once it is older
 * than {@link STALE_MERGE_MS} (the lock row's `updated_at`).
 */

import { and, eq, sql } from 'drizzle-orm';
import { environments, type Database } from '@lumibase/database';
import { EnvironmentError } from './errors';
import type { EnvironmentRow } from './environment-service';

export const STALE_MERGE_MS = 15 * 60_000;

export async function acquireMergeLock(db: Database, env: EnvironmentRow): Promise<void> {
  // ISO string: a Date bound inside a raw `sql` template is not serialized by the driver.
  const staleBefore = new Date(Date.now() - STALE_MERGE_MS).toISOString();
  const [row] = await db
    .update(environments)
    .set({ status: 'merging', updatedAt: new Date() })
    .where(
      and(
        eq(environments.siteId, env.siteId),
        eq(environments.id, env.id),
        sql`(${environments.status} = 'ready' or (${environments.status} = 'merging' and ${environments.updatedAt} < ${staleBefore}::timestamp))`,
        sql`not exists (
          select 1 from ${environments} sib
          where sib.site_id = ${env.siteId} and sib.id <> ${env.id}
            and sib.status = 'merging' and sib.updated_at >= ${staleBefore}::timestamp
        )`,
      ),
    )
    .returning({ id: environments.id });
  if (!row) {
    throw new EnvironmentError('ENVIRONMENT_BUSY', 'Another promote is running on this site; try again when it finishes.', 409);
  }
}

export async function releaseMergeLock(db: Database, env: EnvironmentRow, extra: Partial<EnvironmentRow> = {}): Promise<void> {
  await db
    .update(environments)
    .set({ status: 'ready', updatedAt: new Date(), ...extra })
    .where(and(eq(environments.siteId, env.siteId), eq(environments.id, env.id), eq(environments.status, 'merging')));
}
