/**
 * Materialize Service — POST-GA Task #4.
 *
 * Handles physical table creation, refresh, and cleanup for materialized
 * collections. Provides denormalized read tables for hot-path delivery API
 * traffic.
 *
 * Strategy:
 *   1. `createPhysicalTable()` — creates `mat_{materialization_id}` with flattened columns
 *   2. `refreshPhysicalTable()` — TRUNCATE + INSERT INTO ... SELECT
 *   3. `dropPhysicalTable()` — drops the physical table
 *   4. `installAutoRefreshTrigger()` — creates a PG trigger for auto-refresh
 */

import type { Database } from '@lumibase/database';
import { collections, items } from '@lumibase/database';
import { and, eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaterializeConfig {
  id: string;
  siteId: string;
  collection: string;
  target: string;
  refreshStrategy: string;
  projection: { fields: string[]; orderBy?: string };
  filter: Record<string, unknown>;
}

export interface RefreshResult {
  rowCount: number;
  lastRefreshedAt: Date;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Sanitize a materialization id to prevent SQL injection in DDL.
 *
 * Physical table names must be unique per materialization, not just per target:
 * target names are only unique within a site and may be reused by other
 * tenants. Using the metadata id keeps DDL, refreshes, drops, and reads scoped
 * to a caller-owned materialization.
 */
function sanitizeTableName(materializationId: string): string {
  const clean = materializationId
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 59);
  if (!clean) {
    throw new Error(`Invalid materialized collection id: ${materializationId}`);
  }
  return `mat_${clean}`;
}

/**
 * Creates a physical table for a materialized collection.
 *
 * The table uses a flat schema:
 *   - id TEXT PRIMARY KEY
 *   - site_id TEXT NOT NULL
 *   - status TEXT
 *   - data JSONB
 *   - created_at TIMESTAMPTZ
 *   - updated_at TIMESTAMPTZ
 *
 * For specific field projections (not `*`), individual columns are
 * extracted from JSONB into typed columns in future iterations.
 */
export async function createPhysicalTable(
  db: Database,
  config: MaterializeConfig,
): Promise<void> {
  const tableName = sanitizeTableName(config.id);

  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      data JSONB DEFAULT '{}',
      sort INTEGER DEFAULT 0,
      user_created TEXT,
      user_updated TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `));

  // Create an index for site-scoped queries
  await db.execute(sql.raw(`
    CREATE INDEX IF NOT EXISTS ${tableName}_site_idx
    ON ${tableName} (site_id, status)
  `));
}

/**
 * Refreshes the physical table by truncating and re-inserting from the
 * source `items` table, applying the projection and filter.
 */
export async function refreshPhysicalTable(
  db: Database,
  config: MaterializeConfig,
): Promise<RefreshResult> {
  const tableName = sanitizeTableName(config.id);
  const startTime = Date.now();

  // Resolve source collection id
  const [coll] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.siteId, config.siteId),
        eq(collections.name, config.collection),
      ),
    );

  if (!coll) {
    throw new Error(`Source collection '${config.collection}' not found`);
  }

  // Truncate the materialized table
  await db.execute(sql.raw(`TRUNCATE TABLE ${tableName}`));

  // Build the INSERT ... SELECT query
  // Apply filter if present (basic status filter for now)
  let filterClause = '';
  if (config.filter && Object.keys(config.filter).length > 0) {
    if (config.filter['status']) {
      const status = String(config.filter['status']).replace(/'/g, "''");
      filterClause = ` AND i.status = '${status}'`;
    }
  }

  // Build field projection (if not wildcard, extract specific JSONB keys)
  const projectionFields = config.projection?.fields ?? ['*'];
  let dataProjection = 'i.data';
  if (!projectionFields.includes('*') && projectionFields.length > 0) {
    // Build a JSONB object with only the projected fields
    const fieldExprs = projectionFields
      .map((f) => {
        const safe = f.replace(/[^a-zA-Z0-9_]/g, '');
        return `'${safe}', i.data->'${safe}'`;
      })
      .join(', ');
    dataProjection = `jsonb_build_object(${fieldExprs})`;
  }

  const orderClause = config.projection?.orderBy
    ? `ORDER BY i.data->>'${config.projection.orderBy.replace(/[^a-zA-Z0-9_]/g, '')}'`
    : 'ORDER BY i.sort, i.created_at';

  await db.execute(sql.raw(`
    INSERT INTO ${tableName} (id, site_id, collection_id, status, data, sort, user_created, user_updated, created_at, updated_at)
    SELECT i.id, i.site_id, i.collection_id, i.status, ${dataProjection}, i.sort, i.user_created, i.user_updated, i.created_at, i.updated_at
    FROM items i
    WHERE i.site_id = '${config.siteId.replace(/'/g, "''")}'
      AND i.collection_id = '${coll.id.replace(/'/g, "''")}'
      AND i.deleted_at IS NULL
      ${filterClause}
    ${orderClause}
  `));

  // Count rows in the materialized table
  const countResult = await db.execute(
    sql.raw(`SELECT COUNT(*) as cnt FROM ${tableName}`),
  );
  const rowCount = Number((countResult as unknown as Array<{ cnt: string }>)[0]?.cnt ?? 0);

  const durationMs = Date.now() - startTime;

  return {
    rowCount,
    lastRefreshedAt: new Date(),
    durationMs,
  };
}

/**
 * Drops the physical materialized table.
 */
export async function dropPhysicalTable(
  db: Database,
  config: MaterializeConfig,
): Promise<void> {
  const tableName = sanitizeTableName(config.id);
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${tableName} CASCADE`));
}

/**
 * Installs a PostgreSQL trigger that fires after INSERT/UPDATE/DELETE
 * on the items table for the source collection, sending a NOTIFY event
 * that can be consumed to trigger a refresh.
 *
 * Note: The actual refresh is handled by a listener (not part of the
 * trigger itself) to avoid long-running transactions.
 */
export async function installAutoRefreshTrigger(
  db: Database,
  config: MaterializeConfig,
): Promise<void> {
  const triggerSuffix = sanitizeTableName(config.id).replace(/^mat_/, '');
  const triggerName = `trg_mat_refresh_${triggerSuffix}`;
  const channelName = `mat_refresh_${triggerSuffix}`;

  // Resolve source collection id
  const [coll] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.siteId, config.siteId),
        eq(collections.name, config.collection),
      ),
    );

  if (!coll) {
    throw new Error(`Source collection '${config.collection}' not found`);
  }

  // Create the trigger function
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION ${triggerName}_fn()
    RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('${channelName}', json_build_object(
        'target', '${config.target.replace(/'/g, "''")}',
        'site_id', '${config.siteId.replace(/'/g, "''")}',
        'action', TG_OP
      )::text);
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql
  `));

  // Create the trigger
  await db.execute(sql.raw(`
    DROP TRIGGER IF EXISTS ${triggerName} ON items;
    CREATE TRIGGER ${triggerName}
    AFTER INSERT OR UPDATE OR DELETE ON items
    FOR EACH ROW
    WHEN (NEW.collection_id = '${coll.id}' OR OLD.collection_id = '${coll.id}')
    EXECUTE FUNCTION ${triggerName}_fn()
  `));
}

/**
 * Removes auto-refresh trigger for a materialized collection.
 */
export async function removeAutoRefreshTrigger(
  db: Database,
  config: MaterializeConfig,
): Promise<void> {
  const triggerName = `trg_mat_refresh_${sanitizeTableName(config.id).replace(
    /^mat_/,
    '',
  )}`;

  await db.execute(sql.raw(`
    DROP TRIGGER IF EXISTS ${triggerName} ON items;
    DROP FUNCTION IF EXISTS ${triggerName}_fn();
  `));
}

/**
 * Query a materialized physical table directly.
 * Returns rows from the denormalized table (much faster than JSONB queries).
 */
export async function queryPhysicalTable(
  db: Database,
  materializationId: string,
  siteId: string,
  opts: { limit?: number; offset?: number; status?: string } = {},
): Promise<{ data: unknown[]; total: number }> {
  const tableName = sanitizeTableName(materializationId);
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const escapedSiteId = siteId.replace(/'/g, "''");
  const statusFilter = opts.status
    ? `AND status = '${opts.status.replace(/'/g, "''")}'`
    : '';

  const rows = await db.execute(sql.raw(`
    SELECT * FROM ${tableName}
    WHERE site_id = '${escapedSiteId}' ${statusFilter}
    ORDER BY sort, created_at
    LIMIT ${limit} OFFSET ${offset}
  `));

  const countResult = await db.execute(sql.raw(`
    SELECT COUNT(*) as cnt FROM ${tableName}
    WHERE site_id = '${escapedSiteId}' ${statusFilter}
  `));
  const total = Number((countResult as unknown as Array<{ cnt: string }>)[0]?.cnt ?? 0);

  return { data: rows as unknown as unknown[], total };
}
