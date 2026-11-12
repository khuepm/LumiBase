import { sql } from 'drizzle-orm';
/**
 * Capability-resolution workload for #583: latency of the governed AI entry
 * point (`EffectiveCapabilityService.resolve`) with and without the permission
 * bundle cache, and for a principal whose policies are IP-guarded (compiled per
 * request since the F2 fix).
 *
 * Usage (throwaway database only; the script creates and deletes its own site):
 *
 *   DATABASE_URL=postgresql://… pnpm -F @lumibase/cms exec tsx eval/permission-cache/bench.ts [iterations]
 *
 * The cache is the in-process `MemoryCacheProvider`, so the "cached" numbers
 * exclude a Redis/KV round trip. No model is called.
 */
import { inArray } from 'drizzle-orm';
import {
  createDb,
  permissions as permissionsTable,
  policies,
  rolePolicies,
  roles,
  sites,
  userPolicies,
  userSites,
  users,
} from '@lumibase/database';
import { MemoryCacheProvider, type CacheProvider } from '@lumibase/runtime';
import { EffectiveCapabilityService } from '../../src/services/effective-capability-service';
import { __resetPermissionProcessCacheForTests } from '../../src/services/permission-service';

const SITE = 'site_583_bench';
const ROLE = 'role_583_bench';
const PLAIN = 'usr_583_bench_plain';
const GUARDED = 'usr_583_bench_guarded';
const IP = '10.58.3.10';

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  const iterations = Number(process.argv[2] ?? 500);
  const db = createDb(url);

  const cleanup = async () => {
    await db.delete(sites).where(inArray(sites.id, [SITE]));
    await db.delete(users).where(inArray(users.id, [PLAIN, GUARDED]));
  };
  await cleanup();
  await db.insert(sites).values({ organizationId: sql`(SELECT id FROM lumibase_organizations WHERE slug = 'default')`, id: SITE, name: '583 bench' });
  await db.insert(users).values([
    { id: PLAIN, email: 'bench-583-plain@example.dev' },
    { id: GUARDED, email: 'bench-583-guarded@example.dev' },
  ]);
  await db.insert(roles).values({ id: ROLE, siteId: SITE, name: '583 bench', adminAccess: false, appAccess: true });
  await db.insert(userSites).values([
    { userId: PLAIN, siteId: SITE, roleId: ROLE },
    { userId: GUARDED, siteId: SITE, roleId: ROLE },
  ]);
  const [reader] = await db.insert(policies).values({ siteId: SITE, name: 'reader' }).returning({ id: policies.id });
  const collectionsRead = Array.from({ length: 20 }, (_, i) => `c${i}`);
  await db.insert(permissionsTable).values(
    collectionsRead.map((collection) => ({ siteId: SITE, policyId: reader!.id, collection, action: 'read', fields: ['*'] })),
  );
  await db.insert(rolePolicies).values({ roleId: ROLE, policyId: reader!.id, priority: 0 });
  const [locked] = await db
    .insert(policies)
    .values({ siteId: SITE, name: 'office only', ipAllow: [IP] })
    .returning({ id: policies.id });
  await db.insert(permissionsTable).values({ siteId: SITE, policyId: locked!.id, collection: 'secret', action: 'read', fields: ['*'] });
  await db.insert(userPolicies).values({ userId: GUARDED, siteId: SITE, policyId: locked!.id, priority: 1 });

  async function measure(label: string, userId: string, cache: CacheProvider | undefined) {
    __resetPermissionProcessCacheForTests();
    const run = () =>
      new EffectiveCapabilityService({ db, siteId: SITE, ip: IP, environment: 'production', ...(cache ? { cache } : {}) })
        .resolve({ type: 'user', siteId: SITE, userId });
    for (let i = 0; i < 20; i++) await run(); // warm-up
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const grant = await run();
      samples.push(performance.now() - start);
      if (!grant.allowed) throw new Error(`${label}: principal did not resolve`);
    }
    samples.sort((a, b) => a - b);
    const f = (n: number) => n.toFixed(3);
    console.log(
      `${label.padEnd(34)} n=${iterations} p50=${f(percentile(samples, 50))}ms p95=${f(percentile(samples, 95))}ms p99=${f(percentile(samples, 99))}ms`,
    );
  }

  try {
    await measure('no cache (compile every call)', PLAIN, undefined);
    await measure('cached, unguarded principal', PLAIN, new MemoryCacheProvider());
    await measure('cached, IP-guarded principal', GUARDED, new MemoryCacheProvider());
  } finally {
    await cleanup();
  }
  process.exit(0);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
