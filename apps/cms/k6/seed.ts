#!/usr/bin/env tsx
/**
 * Phase 0 load-test dataset.
 *
 * Creates two sites and five collections per site. The primary site receives
 * 100,000 items in each collection (500,000 total); the secondary site stays
 * empty so cross-tenant and cache-isolation checks can use the same fixture.
 * One hundred public pages per site reference every primary collection.
 *
 * This script is additive and rerunnable: all IDs are deterministic nanoid-
 * shaped strings and inserts use ON CONFLICT DO NOTHING. It never truncates
 * application tables.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... pnpm exec tsx apps/cms/k6/seed.ts
 *   ITEMS_PER_COLLECTION=1000 PAGES_PER_SITE=10 .../seed.ts  # smoke fixture
 */

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
const databaseUrl: string = DATABASE_URL;

const PRIMARY_SITE_ID = 'loadtest-main-00000001';
const SECONDARY_SITE_ID = 'loadtest-side-00000001';
const SITE_IDS = [PRIMARY_SITE_ID, SECONDARY_SITE_ID];

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer; received ${raw ?? '(unset)'}`);
  }
  return value;
}

const COLLECTION_COUNT = positiveInt('COLLECTION_COUNT', 5);
const ITEMS_PER_COLLECTION = positiveInt('ITEMS_PER_COLLECTION', 100_000);
const PAGES_PER_SITE = positiveInt('PAGES_PER_SITE', 100);
const BATCH_SIZE = positiveInt('BATCH_SIZE', 1_000);
const MAX_ID_PART = 999_999;
if (COLLECTION_COUNT > MAX_ID_PART || ITEMS_PER_COLLECTION > MAX_ID_PART || PAGES_PER_SITE > MAX_ID_PART) {
  throw new Error(`COLLECTION_COUNT, ITEMS_PER_COLLECTION, and PAGES_PER_SITE must be <= ${MAX_ID_PART}`);
}

function id(prefix: string, ...parts: number[]) {
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0 || part > 999_999)) {
    throw new Error(`ID parts must be safe integers in [0, 999999]; prefix=${prefix}, parts=${parts.join(',')}`);
  }
  const value = `${prefix}${parts.map((part) => String(part).padStart(6, '0')).join('')}`;
  if (value.length > 21) {
    throw new Error(`Generated ID exceeds nanoid length 21: ${value}`);
  }
  return value.padEnd(21, '0');
}

function placeholders(rowWidth: number, rowCount: number) {
  return Array.from({ length: rowCount }, (_, row) =>
    `(${Array.from({ length: rowWidth }, (_, column) => `$${row * rowWidth + column + 1}`).join(',')})`,
  ).join(',');
}

async function insertBatch(
  sql: postgres.Sql,
  table: string,
  columns: string,
  rows: unknown[][],
  conflictClause = 'ON CONFLICT DO NOTHING',
) {
  if (rows.length === 0) return;
  const query = `INSERT INTO ${table} (${columns}) VALUES ${placeholders(rows[0].length, rows.length)} ${conflictClause}`;
  await sql.unsafe(query, rows.flat() as never[]);
}

async function main() {
  const sql = postgres(databaseUrl, { max: 4, prepare: false });
  try {
    console.log(`[seed-load] sites=${SITE_IDS.join(',')} collections=${COLLECTION_COUNT} items/collection=${ITEMS_PER_COLLECTION} pages/site=${PAGES_PER_SITE}`);

    await insertBatch(sql, 'lumibase_sites', 'id,name,domain,display_title,site_url', [
      [PRIMARY_SITE_ID, 'High-load primary', 'loadtest-main.local', 'High-load primary', 'http://loadtest-main.local'],
      [SECONDARY_SITE_ID, 'High-load secondary', 'loadtest-side.local', 'High-load secondary', 'http://loadtest-side.local'],
    ]);
    await sql.unsafe(`
      INSERT INTO lumibase_system_state (id, state, admin_path, initialized_at)
      VALUES ('singleton', 'initialized', '/loadtest-admin', now())
      ON CONFLICT (id) DO UPDATE SET state = 'initialized', admin_path = '/loadtest-admin'
    `);
    await sql.unsafe(`
      INSERT INTO lumibase_users (id, email, status, is_bootstrap)
      VALUES ('loadtest-user-00000001', 'loadtest-admin@lumibase.dev', 'active', true)
      ON CONFLICT (id) DO UPDATE SET is_bootstrap = true, status = 'active'
    `);
    await sql.unsafe(`
      INSERT INTO lumibase_roles (id, site_id, key, system_key, name, admin_access, app_access)
      VALUES ('loadtest-admin-role01', '${PRIMARY_SITE_ID}', 'loadtest_admin', 'loadtest_admin', 'Load-test administrator', true, true)
      ON CONFLICT (id) DO UPDATE SET admin_access = true, app_access = true
    `);
    await sql.unsafe(`
      INSERT INTO lumibase_user_sites (user_id, site_id, role_id)
      VALUES ('loadtest-user-00000001', '${PRIMARY_SITE_ID}', 'loadtest-admin-role01')
      ON CONFLICT (user_id, site_id) DO UPDATE SET role_id = 'loadtest-admin-role01'
    `);
    await sql.unsafe(`
      INSERT INTO lumibase_policies (id, site_id, key, name, admin_access, app_access, enforce_tfa, ip_allow, ip_deny, rules)
      VALUES ('loadtest-admin-policy1', '${PRIMARY_SITE_ID}', 'loadtest_admin', 'Load-test administrator policy', true, true, false, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
      ON CONFLICT (id) DO UPDATE SET admin_access = true, app_access = true
    `);
    await sql.unsafe(`
      INSERT INTO lumibase_role_policies (role_id, policy_id, priority)
      VALUES ('loadtest-admin-role01', 'loadtest-admin-policy1', 1)
      ON CONFLICT (role_id, policy_id) DO NOTHING
    `);

    const collections: Array<{ siteId: string; id: string; name: string }> = [];
    for (let siteIndex = 0; siteIndex < SITE_IDS.length; siteIndex += 1) {
      const siteId = SITE_IDS[siteIndex];
      const rows = [];
      for (let collectionIndex = 0; collectionIndex < COLLECTION_COUNT; collectionIndex += 1) {
        const name = `loadtest_collection_${String(collectionIndex + 1).padStart(2, '0')}`;
        const collectionId = id('C', siteIndex + 1, collectionIndex + 1);
        collections.push({ siteId, id: collectionId, name });
        rows.push([collectionId, siteId, name, `Load test ${name}`, `Load test ${name}`, false, false]);
      }
      await insertBatch(sql, 'lumibase_collections', 'id,site_id,name,label,plural_label,hidden,system', rows);
    }

    for (let siteIndex = 0; siteIndex < SITE_IDS.length; siteIndex += 1) {
      const siteId = SITE_IDS[siteIndex];
      const siteCollections = collections.filter((collection) => collection.siteId === siteId);
      const pageRows = [];
      for (let pageIndex = 1; pageIndex <= PAGES_PER_SITE; pageIndex += 1) {
        const sections = siteCollections.map((collection, collectionIndex) => ({
          id: id('S', siteIndex + 1, pageIndex, collectionIndex + 1),
          component: 'collection-list',
          styleConfig: {},
          data: {},
          source: { collection: collection.name, limit: 10, status: 'published' },
        }));
        pageRows.push([
          id('P', siteIndex + 1, pageIndex), siteId,
          `loadtest-page-${String(pageIndex).padStart(3, '0')}`,
          `Load test page ${pageIndex}`,
          JSON.stringify({ sections }),
        ]);
      }
      await insertBatch(
        sql,
        'lumibase_pages',
        'id,site_id,slug,title,layout_config',
        pageRows,
        'ON CONFLICT (site_id,slug) DO UPDATE SET title = EXCLUDED.title, layout_config = EXCLUDED.layout_config, updated_at = now()',
      );
    }

    // Only the primary site's content is large by design; the second site is
    // reserved for tenant-isolation probes without doubling the seed cost.
    const primaryCollections = collections.filter((collection) => collection.siteId === PRIMARY_SITE_ID);
    let inserted = 0;
    for (let collectionIndex = 0; collectionIndex < primaryCollections.length; collectionIndex += 1) {
      const collection = primaryCollections[collectionIndex];
      for (let offset = 0; offset < ITEMS_PER_COLLECTION; offset += BATCH_SIZE) {
        const rows = [];
        const end = Math.min(offset + BATCH_SIZE, ITEMS_PER_COLLECTION);
        for (let itemIndex = offset; itemIndex < end; itemIndex += 1) {
          rows.push([
            id('I', collectionIndex + 1, itemIndex + 1),
            PRIMARY_SITE_ID,
            collection.id,
            'published',
            JSON.stringify({
              title: `Load test item ${itemIndex + 1}`,
              slug: `loadtest-item-${itemIndex + 1}`,
              rank: itemIndex + 1,
              collection: collection.name,
            }),
            0,
          ]);
        }
        await insertBatch(sql, 'lumibase_items', 'id,site_id,collection_id,status,data,sort', rows);
        inserted += rows.length;
        if (inserted % 50_000 === 0 || end === ITEMS_PER_COLLECTION) {
          console.log(`[seed-load] ${collection.name}: ${end}/${ITEMS_PER_COLLECTION}; total=${inserted}`);
        }
      }
    }
    console.log(`[seed-load] complete; primary items=${inserted}`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('[seed-load] FAILED', error);
  process.exitCode = 1;
});
