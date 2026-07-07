#!/usr/bin/env tsx
/**
 * Dev seed: inserts the minimal rows needed for local Studio development.
 *
 * Creates:
 *   - `sites` row with id='site_demo'  (matches DEFAULT_DEV_SITE in studio/src/lib/api.ts)
 *   - `system_state` singleton row     (prevents adminPathGuard from blocking all routes)
 *   - baseline access roles/policies and explicit system collection permissions
 *
 * Safe to re-run: all access rows use stable ids and ON CONFLICT upserts.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm --filter @lumibase/database seed:dev
 *   # or simply from the monorepo root:
 *   pnpm db:seed-dev
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { DEV_ACCESS_SEED } from '../src/seeds/dev-access';

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
    sql`INSERT INTO lumibase_sites (id, name, domain) VALUES ('site_demo', 'Demo Site', 'localhost')
        ON CONFLICT (id) DO NOTHING`
  );
  console.log('[seed-dev] ✓ site_demo site row');

  // 2. system_state singleton (needed for adminPathGuard to not block API routes
  //    while the Setup Wizard hasn't been run)
  await db.execute(
    sql`INSERT INTO lumibase_system_state (id, state) VALUES ('singleton', 'initialized')
        ON CONFLICT (id) DO NOTHING`
  );
  console.log('[seed-dev] ✓ system_state singleton (state=initialized)');

  for (const role of DEV_ACCESS_SEED.roles) {
    await db.execute(
      sql`INSERT INTO lumibase_roles (
            id, site_id, key, system_key, name, description, icon, admin_access, app_access
          )
          VALUES (
            ${role.id}, ${role.siteId}, ${role.key}, ${role.systemKey}, ${role.name},
            ${role.description}, ${role.icon}, ${role.adminAccess}, ${role.appAccess}
          )
          ON CONFLICT (id) DO UPDATE SET
            site_id = EXCLUDED.site_id,
            key = EXCLUDED.key,
            system_key = EXCLUDED.system_key,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            icon = EXCLUDED.icon,
            admin_access = EXCLUDED.admin_access,
            app_access = EXCLUDED.app_access`
    );
  }
  console.log(`[seed-dev] ✓ access roles (${DEV_ACCESS_SEED.roles.length})`);

  for (const policy of DEV_ACCESS_SEED.policies) {
    await db.execute(
      sql`INSERT INTO lumibase_policies (
            id, site_id, key, name, description, icon, admin_access, app_access,
            enforce_tfa, ip_allow, ip_deny, rules
          )
          VALUES (
            ${policy.id}, ${policy.siteId}, ${policy.key}, ${policy.name},
            ${policy.description}, ${policy.icon}, ${policy.adminAccess},
            ${policy.appAccess}, ${policy.enforceTfa}, ${JSON.stringify(policy.ipAllow)}::jsonb,
            ${JSON.stringify(policy.ipDeny)}::jsonb, ${JSON.stringify(policy.rules)}::jsonb
          )
          ON CONFLICT (id) DO UPDATE SET
            site_id = EXCLUDED.site_id,
            key = EXCLUDED.key,
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            icon = EXCLUDED.icon,
            admin_access = EXCLUDED.admin_access,
            app_access = EXCLUDED.app_access,
            enforce_tfa = EXCLUDED.enforce_tfa,
            ip_allow = EXCLUDED.ip_allow,
            ip_deny = EXCLUDED.ip_deny,
            rules = EXCLUDED.rules`
    );
  }
  console.log(`[seed-dev] ✓ access policies (${DEV_ACCESS_SEED.policies.length})`);

  for (const binding of DEV_ACCESS_SEED.rolePolicies) {
    await db.execute(
      sql`INSERT INTO lumibase_role_policies (role_id, policy_id, priority)
          VALUES (${binding.roleId}, ${binding.policyId}, ${binding.priority})
          ON CONFLICT (role_id, policy_id) DO UPDATE SET
            priority = EXCLUDED.priority`
    );
  }
  console.log(`[seed-dev] ✓ role policy bindings (${DEV_ACCESS_SEED.rolePolicies.length})`);

  for (const permission of DEV_ACCESS_SEED.permissions) {
    await db.execute(
      sql`INSERT INTO lumibase_permissions (
            id, site_id, policy_id, collection, action, permissions, validation, presets, fields
          )
          VALUES (
            ${permission.id}, ${permission.siteId}, ${permission.policyId},
            ${permission.collection}, ${permission.action},
            ${JSON.stringify(permission.permissions)}::jsonb,
            ${JSON.stringify(permission.validation)}::jsonb,
            ${JSON.stringify(permission.presets)}::jsonb,
            ${JSON.stringify(permission.fields)}::jsonb
          )
          ON CONFLICT (policy_id, collection, action) DO UPDATE SET
            id = EXCLUDED.id,
            site_id = EXCLUDED.site_id,
            permissions = EXCLUDED.permissions,
            validation = EXCLUDED.validation,
            presets = EXCLUDED.presets,
            fields = EXCLUDED.fields`
    );
  }
  console.log(`[seed-dev] ✓ explicit system permissions (${DEV_ACCESS_SEED.permissions.length})`);

  console.log('[seed-dev] Done. You can now use the Studio with site_demo.');
  await client.end();
}

main().catch((err) => {
  console.error('[seed-dev] FAILED:', err);
  process.exit(1);
});
