#!/usr/bin/env tsx
/**
 * Dev seed: inserts the minimal rows needed for local Studio development.
 *
 * Creates:
 *   - `sites` row with id='site_demo'  (matches DEFAULT_DEV_SITE in studio/src/lib/api.ts)
 *   - `system_state` singleton row     (prevents adminPathGuard from blocking all routes)
 *
 * TODO(access-seed): when the advanced Permission Builder lands, also seed
 * baseline admin/studio-self/public policies and explicit permissions for
 * system collections. See:
 * docs/vi/features/permission-builder-directus-investigation.md
 *
 * Safe to re-run: all inserts use ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm --filter @lumibase/database seed:dev
 *   # or simply from the monorepo root:
 *   pnpm db:seed-dev
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Error: DATABASE_URL is required.');
    process.exit(1);
  }

  console.log('[seed-dev] Connecting to:', url.replace(/:([^:@]+)@/, ':***@'));
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  // 1. Default dev site (referenced by Studio DEFAULT_DEV_SITE = 'site_demo')
  await db.execute(
    sql`INSERT INTO sites (id, name, domain) VALUES ('site_demo', 'Demo Site', 'localhost')
        ON CONFLICT (id) DO NOTHING`
  );
  console.log('[seed-dev] ✓ site_demo site row');

  // 2. system_state singleton (needed for adminPathGuard to not block API routes
  //    while the Setup Wizard hasn't been run)
  await db.execute(
    sql`INSERT INTO system_state (id, state) VALUES ('singleton', 'initialized')
        ON CONFLICT (id) DO NOTHING`
  );
  console.log('[seed-dev] ✓ system_state singleton (state=initialized)');

  console.log('[seed-dev] Done. You can now use the Studio with site_demo.');
  await client.end();
}

main().catch((err) => {
  console.error('[seed-dev] FAILED:', err);
  process.exit(1);
});
