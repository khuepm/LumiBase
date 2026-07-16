#!/usr/bin/env tsx
/**
 * RBAC role→policy flag backfill runner (upgrade path 0.6.x → 1.0).
 *
 * Materializes legacy `roles.admin_access/app_access` flags into flag-only
 * policies per docs/en/features/role-policy-flag-migration.md. Idempotent;
 * never mutates role flags. Run against staging first.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @lumibase/database backfill:role-policies            # apply + verify
 *   DATABASE_URL=... pnpm --filter @lumibase/database backfill:role-policies verify     # post-check only
 *   DATABASE_URL=... pnpm --filter @lumibase/database backfill:role-policies rollback   # compat-window rollback
 */
import { createDb } from '../src/client';
import {
  backfillRolePolicyFlags,
  findUnbackfilledRoles,
  rollbackRolePolicyBackfill,
} from '../src/backfill/role-policies';

type Command = 'apply' | 'verify' | 'rollback';

function parseCommand(argv: string[]): Command {
  const [command] = argv;
  switch (command) {
    case undefined:
    case 'apply':
      return 'apply';
    case 'verify':
    case 'check':
      return 'verify';
    case 'rollback':
      return 'rollback';
    default:
      console.error(`Error: unknown command "${command}". Usage: backfill-role-policies [apply|verify|rollback]`);
      process.exit(1);
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Error: DATABASE_URL is required.');
    process.exit(1);
  }

  const command = parseCommand(process.argv.slice(2));
  const db = createDb(url);

  if (command === 'rollback') {
    const { policiesDeleted } = await rollbackRolePolicyBackfill(db);
    console.log(`[backfill] Rollback complete: removed ${policiesDeleted} legacy_role_flags_* policies.`);
    return;
  }

  if (command === 'apply') {
    const result = await backfillRolePolicyFlags(db);
    console.log(
      `[backfill] Applied: ${result.legacyRoleCount} legacy roles, ` +
        `${result.policiesUpserted} policies upserted, ${result.linksInserted} links inserted.`,
    );
  }

  const unbackfilled = await findUnbackfilledRoles(db);
  if (unbackfilled.length > 0) {
    console.error(`[backfill] POST-CHECK FAILED: ${unbackfilled.length} role(s) still lack a matching policy:`);
    for (const role of unbackfilled) {
      console.error(
        `  - ${role.id} (site=${role.siteId}, name=${role.name}, admin=${role.adminAccess}, app=${role.appAccess})`,
      );
    }
    process.exit(1);
  }
  console.log('[backfill] Post-check clean: every legacy-flag role has a matching policy.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill] FAILED:', err);
    process.exit(1);
  });
