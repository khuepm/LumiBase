import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';

/**
 * Security-domain tables for the Admin Setup Wizard feature.
 *
 * `system_state` is a singleton row keyed by `id='singleton'` (enforced
 * via CHECK constraint). It tracks whether the instance has been
 * bootstrapped and, once initialized, the custom Admin Path used by the
 * `adminPathGuard` middleware to serve the Studio.
 *
 * `audit_log` is the append-only event store for every security-relevant
 * action surfaced by the Setup Wizard, Login Guard, Anomaly Detector,
 * and Recovery Service.
 *
 * See `.kiro/specs/admin-setup-wizard/design.md` §3.2 (system_state),
 * §3.6 (audit_log), and §10 (audit write path / retention) for the
 * contracts these tables enforce.
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

/**
 * Append-only security audit trail.
 *
 * Writes happen synchronously on the request path (≤1s budget per
 * design §10.1); the rotator job purges rows older than
 * `LUMIBASE_AUDIT_RETENTION_DAYS` (default 90, design §10.2). The three
 * indexes cover the query shapes exposed by `GET /admin/security/audit-log`:
 * recent activity (timestamp DESC), per-event timelines, and per-actor
 * timelines.
 *
 * `event` stores one of the 15 codes from Req 15.1 as plain text rather
 * than a Postgres enum so new codes can be added without a schema
 * migration. `metadata` is capped at ~4KB serialized; sensitive fields
 * (passwordHash, setupToken, backupCode, recoveryToken) are masked
 * before write per Req 15.3.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id')
      .$defaultFn(() => nanoid())
      .primaryKey(),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
    /** One of the 15 event codes from Req 15.1; stored as text. */
    event: text('event').notNull(),
    /** Email of the user performing the action; null for unauthenticated events. */
    actorEmail: text('actor_email'),
    /** Email of the user the action targets (e.g. for unlock-user). */
    targetEmail: text('target_email'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** ISO-3166 alpha-2; null when GeoIP unavailable. */
    countryCode: text('country_code'),
    /** Event-specific payload, ≤4KB serialized, with secrets masked. */
    metadata: jsonb('metadata').default({}).notNull(),
    /** Correlates with the `requestId` middleware-generated header. */
    requestId: text('request_id'),
  },
  (t) => ({
    /** Recent-activity scans and retention rotation. */
    tsIdx: index('audit_log_ts_idx').on(t.timestamp),
    /** Per-event timelines (e.g. all `login_failed` over a window). */
    eventIdx: index('audit_log_event_idx').on(t.event, t.timestamp),
    /** Per-actor timelines for incident investigation. */
    actorIdx: index('audit_log_actor_idx').on(t.actorEmail, t.timestamp),
  }),
);
