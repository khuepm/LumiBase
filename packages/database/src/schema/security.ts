import { sql } from 'drizzle-orm';
import {
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Security-domain tables for the Admin Setup Wizard feature.
 *
 * `system_state` is a singleton row keyed by `id='singleton'` (enforced
 * via CHECK constraint). It tracks whether the instance has been
 * bootstrapped and, once initialized, the custom Admin Path used by the
 * `adminPathGuard` middleware to serve the Studio.
 *
 * See `.kiro/specs/admin-setup-wizard/design.md` §3.2 (data model) and
 * §6.5 (atomic setup transaction) for the contract this row enforces.
 */

export const systemState = pgTable(
  'system_state',
  {
    /** Always `'singleton'` — enforced by the CHECK constraint below. */
    id: text('id').primaryKey().default('singleton'),
    /**
     * Lifecycle state. `initializing` is the in-flight value held under
     * a row lock during `POST /setup/complete`; on commit it flips to
     * `initialized`, on rollback it reverts to `uninitialized`.
     */
    state: text('state', {
      enum: ['uninitialized', 'initializing', 'initialized'],
    })
      .default('uninitialized')
      .notNull(),
    /** Custom Admin Path (e.g. `/lumi-7f3a9c`); null while uninitialized. */
    adminPath: text('admin_path'),
    /** sha256 hex of the bootstrap Setup Token; null after init. */
    setupTokenHash: text('setup_token_hash'),
    /** Wall-clock time at which `state` flipped to `initialized`. */
    initializedAt: timestamp('initialized_at'),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    /** Admin Path is globally unique per instance. */
    adminPathUnique: uniqueIndex('system_state_admin_path_unique').on(
      t.adminPath,
    ),
    /** Singleton enforcement: only one row, with id = 'singleton'. */
    singletonCheck: check(
      'system_state_singleton_chk',
      sql`${t.id} = 'singleton'`,
    ),
  }),
);
