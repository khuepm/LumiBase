import { sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { check, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * In-app upgrade requests (#898, epic #869 part 2).
 *
 * A running instance cannot replace itself; `POST /api/v1/system/upgrade`
 * asks something outside the process (a CI webhook, an updater service, the
 * LumiBase control plane) to roll the deployment to `targetVersion`, and
 * records the request here.
 *
 * Deployment-wide, like `lumibase_release_manifests`: an upgrade replaces the
 * code for every site, so the row has no `site_id` and holds no tenant data.
 * One row per target version (unique) makes the request idempotent: asking
 * again for the same target returns the recorded request instead of firing
 * the hook twice, unless the previous attempt failed and is retried.
 */
export const upgradeRequests = pgTable(
  'lumibase_upgrade_requests',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    targetVersion: text('target_version').notNull(),
    fromVersion: text('from_version').notNull(),
    /** `requested` (hook accepted) · `completed` (target answered) · `failed` (hook refused or errored). */
    status: text('status').notNull(),
    /** Upgrade provider key, e.g. `webhook`. */
    provider: text('provider').notNull(),
    requestedBy: text('requested_by'),
    requestedAt: timestamp('requested_at').defaultNow().notNull(),
    /** HTTP status the hook answered, when it answered. */
    hookStatus: integer('hook_status'),
    /** Reference the hook returned (CI run id, job id), when any. */
    hookReference: text('hook_reference'),
    error: text('error'),
    completedAt: timestamp('completed_at'),
    attempts: integer('attempts').default(1).notNull(),
  },
  (t) => ({
    targetUnique: uniqueIndex('upgrade_requests_target_uq').on(t.targetVersion),
    statusCheck: check('upgrade_requests_status_chk', sql`${t.status} in ('requested', 'completed', 'failed')`),
  }),
);
