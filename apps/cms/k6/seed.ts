#!/usr/bin/env tsx
/**
 * High-load baseline seed (high-load-cache-readiness task 0.2).
 *
 * Creates a reproducible dataset for k6 deliver/list benchmarks and EXPLAIN
 * spikes (task 18):
 *   - 2 sites × 5 collections × N items (N = SEED_ITEMS per collection)
 *   - ≥60 deliver pages per site (home + page-001..page-059) for Zipf traffic
 *   - `system_state` initialized so authenticated list traffic works
 *
 * Defaults:
 *   SEED_ITEMS=1000   — CI / quick local runs (~10k items total)
 *   SEED_ITEMS=100000 — full baseline per design §13.3 / task 0.2
 *
 * Usage:
 *   DATABASE_URL=postgres://lumibase:lumibase_dev@localhost:5432/lumibase \
 *     tsx apps/cms/k6/seed.ts
 *
 *   SEED_ITEMS=100000 DATABASE_URL=... tsx apps/cms/k6/seed.ts
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { nanoid } from 'nanoid';

const SITES = [
  { id: 'site_load_a', name: 'Load Test Site A', domain: 'load-a.local' },
  { id: 'site_load_b', name: 'Load Test Site B', domain: 'load-b.local' },
] as const;

const COLLECTION_NAMES = ['articles', 'news', 'products', 'events', 'guides'] as const;

const PAGE_SLUGS = ['home', ...Array.from({ length: 59 }, (_, i) => `page-${String(i + 1).padStart(3, '0')}`)];

const ITEMS_PER_COLLECTION = Math.max(1, Number(process.env.SEED_ITEMS || 1000));
const BATCH_SIZE = 500;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[k6-seed] Error: DATABASE_URL is required.');
    process.exit(1);
  }

  console.log('[k6-seed] Connecting:', url.replace(/:([^:@]+)@/, ':***@'));
  console.log(`[k6-seed] Plan: ${SITES.length} sites × ${COLLECTION_NAMES.length} collections × ${ITEMS_PER_COLLECTION} items`);
  console.log('[k6-seed] For full baseline use SEED_ITEMS=100000');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  await db.execute(
    sql`INSERT INTO lumibase_system_state (id, state) VALUES ('singleton', 'initialized')
        ON CONFLICT (id) DO NOTHING`,
  );
  console.log('[k6-seed] ✓ system_state initialized');

  for (const site of SITES) {
    await db.execute(
      sql`INSERT INTO lumibase_sites (id, name, domain)
          VALUES (${site.id}, ${site.name}, ${site.domain})
          ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, domain = EXCLUDED.domain`,
    );
    console.log(`[k6-seed] ✓ site ${site.id}`);

    const collectionIds = new Map<string, string>();
    for (const name of COLLECTION_NAMES) {
      const colId = `seed_${site.id}_${name}`;
      collectionIds.set(name, colId);
      await db.execute(
        sql`INSERT INTO lumibase_collections (id, site_id, name, label, plural_label, system, hidden)
            VALUES (${colId}, ${site.id}, ${name}, ${name}, ${name + 's'}, false, false)
            ON CONFLICT (id) DO UPDATE SET
              site_id = EXCLUDED.site_id,
              name = EXCLUDED.name`,
      );
    }
    console.log(`[k6-seed] ✓ ${COLLECTION_NAMES.length} collections on ${site.id}`);

    for (const slug of PAGE_SLUGS) {
      const pageId = `seed_page_${site.id}_${slug}`;
      await db.execute(
        sql`INSERT INTO lumibase_pages (id, site_id, slug, title, layout_config)
            VALUES (
              ${pageId},
              ${site.id},
              ${slug},
              ${slug === 'home' ? 'Home' : `Page ${slug}`},
              ${JSON.stringify({ sections: [] })}::jsonb
            )
            ON CONFLICT (id) DO UPDATE SET
              slug = EXCLUDED.slug,
              title = EXCLUDED.title,
              layout_config = EXCLUDED.layout_config,
              updated_at = now()`,
      );
    }
    console.log(`[k6-seed] ✓ ${PAGE_SLUGS.length} pages on ${site.id}`);

    let inserted = 0;
    for (const name of COLLECTION_NAMES) {
      const collectionId = collectionIds.get(name)!;
      for (let offset = 0; offset < ITEMS_PER_COLLECTION; offset += BATCH_SIZE) {
        const chunk = Math.min(BATCH_SIZE, ITEMS_PER_COLLECTION - offset);
        const values: string[] = [];
        for (let i = 0; i < chunk; i++) {
          const seq = offset + i;
          const id = nanoid();
          const title = `${name} item ${seq}`;
          const data = JSON.stringify({ title, body: `Seed content ${seq}`, seq });
          values.push(
            `('${id}', '${site.id}', '${collectionId}', 'published', '${data.replace(/'/g, "''")}'::jsonb, ${seq})`,
          );
        }
        await db.execute(
          sql.raw(
            `INSERT INTO lumibase_items (id, site_id, collection_id, status, data, sort)
             VALUES ${values.join(', ')}
             ON CONFLICT (id) DO NOTHING`,
          ),
        );
        inserted += chunk;
      }
      console.log(`[k6-seed] ✓ ${ITEMS_PER_COLLECTION} items in ${site.id}/${name}`);
    }
    console.log(`[k6-seed] site ${site.id} total items inserted/attempted: ${inserted}`);
  }

  console.log('[k6-seed] Done. Use SITE_ID=site_load_a for k6 load-deliver.js');
  await client.end();
}

main().catch((err) => {
  console.error('[k6-seed] FAILED:', err);
  process.exit(1);
});
