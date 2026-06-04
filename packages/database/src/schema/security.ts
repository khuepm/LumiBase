import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';

import { sites, users } from './core';

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();

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
    /** Tenant/site boundary for isolating audit queries and exports. */
    siteId: text('site_id').references(() => sites.id, { onDelete: 'cascade' }),
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
    /** Per-site recent-activity scans and tenant-scoped retention views. */
    siteTsIdx: index('audit_log_site_ts_idx').on(t.siteId, t.timestamp),
    /** Recent-activity scans and retention rotation. */
    tsIdx: index('audit_log_ts_idx').on(t.timestamp),
    /** Per-event timelines (e.g. all `login_failed` over a window). */
    eventIdx: index('audit_log_event_idx').on(t.event, t.timestamp),
    /** Per-actor timelines for incident investigation. */
    actorIdx: index('audit_log_actor_idx').on(t.actorEmail, t.timestamp),
  }),
);

/**
 * Sliding-window source-of-truth for login activity.
 *
 * Every authentication attempt — success or failure — appends a row.
 * `LoginGuard` uses the two `(emailLower, createdAt)` and
 * `(ip, createdAt)` indexes to compute per-user and per-IP failure
 * counts inside the configured rolling window (design §6.4); the
 * `AnomalyDetector` reads `countryCode`, `geoLookupStatus`,
 * `userAgent`, `anomalyScore`, `anomalyTriggered`, and
 * `baselineWarmup` for post-login analysis (design §8).
 *
 * Rows are rotated by the same job that prunes `audit_log`
 * (default >90 days, design §10.2).
 *
 * Contract: see design §3.4. `emailLower` MUST be normalized
 * (lowercase + trim) before insert so window queries can match the
 * index; `userId` is FK with `onDelete: 'set null'` to keep historic
 * attempts queryable after a user is removed.
 */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: id(),
    /** Lowercased + trimmed email used as the per-user counter key. */
    emailLower: text('email_lower').notNull(),
    /** Resolved user id when the email matched a row; null otherwise. */
    userId: text('user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Client IP per `extractClientIp` (CF → XFF → socket). */
    ip: text('ip').notNull(),
    userAgent: text('user_agent'),
    /** ISO-3166 alpha-2 from GeoIP lookup; null when unavailable. */
    countryCode: text('country_code'),
    /** Outcome of the GeoIP lookup for this attempt. */
    geoLookupStatus: text('geo_lookup_status', {
      enum: ['ok', 'unavailable', 'timeout'],
    }),
    /** Final auth outcome surfaced to the response. */
    result: text('result', { enum: ['success', 'fail'] }).notNull(),
    /**
     * Failure reason when `result='fail'`; one of
     * `invalid_credentials | account_locked | ip_blocked | anomaly_lock | mfa_required`.
     */
    reason: text('reason'),
    /** Aggregated anomaly score (0.00–1.00); null when detector skipped. */
    anomalyScore: numeric('anomaly_score', { precision: 4, scale: 2 }),
    /** True when the score crossed the configured threshold. */
    anomalyTriggered: boolean('anomaly_triggered').default(false).notNull(),
    /** True when the detector was in baseline-warmup mode for this user. */
    baselineWarmup: boolean('baseline_warmup').default(false).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    /** Per-user sliding-window failure counts. */
    emailWindowIdx: index('login_attempts_email_window_idx').on(
      t.emailLower,
      t.createdAt,
    ),
    /** Per-IP sliding-window failure counts. */
    ipWindowIdx: index('login_attempts_ip_window_idx').on(t.ip, t.createdAt),
  }),
);

/**
 * Per-user behavioural baselines consumed by the Anomaly Detector.
 *
 * One row per user (PK = `userId`) keeping cheap aggregates that the
 * geo, time, and device subscores read on every successful login.
 * Updates happen inside the same transaction as `LoginGuard.onSuccess`
 * via `apps/cms/src/modules/anomaly/baseline-store.ts` (design §8.2,
 * §8.3) so the baseline never diverges from the recorded
 * `login_attempts` row.
 *
 * Defaults are chosen so a freshly inserted row is immediately usable
 * by the detectors:
 * - `countries` — empty list, capped at 50 entries (Req 9.6).
 * - `hourHistogram` — 24 zeroed buckets, one per UTC hour (Req 10.5).
 * - `deviceFingerprints` — empty LRU list capped at 20 entries (Req 11.6).
 * - `successfulLogins` — gates baseline-warmup mode (geo <3, time <10).
 *
 * Contract: see design §3.5. `onDelete: 'cascade'` mirrors the policy
 * for backup codes — when a user is removed, their baseline goes with
 * them since it has no archival value.
 */
export const loginBaselines = pgTable('login_baselines', {
  /** Owning user; one baseline row per user. */
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** ISO-3166 alpha-2 country codes the user has logged in from; cap 50. */
  countries: jsonb('countries').default([]).notNull(),
  /** Login count per UTC hour (length 24); used by the time subscore. */
  hourHistogram: jsonb('hour_histogram')
    .default(Array(24).fill(0) as number[])
    .notNull(),
  /** LRU of `{ fp, lastSeenAt }` device fingerprints; cap 20. */
  deviceFingerprints: jsonb('device_fingerprints').default([]).notNull(),
  /** Total successful logins; baseline-warmup gate for the detectors. */
  successfulLogins: integer('successful_logins').default(0).notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Single-use offline recovery codes for the Bootstrap Admin.
 *
 * Eight `XXXX-XXXX` codes are minted during the Setup Wizard's final
 * "Recovery Setup" step (Req 14.1) and shown to the operator exactly
 * once. This table stores ONLY the PBKDF2 hash of each code — never the
 * plaintext (Req 14.2). `code_hash` uses the same scheme as the admin
 * password: `pbkdf2$100000$<salt>$<hash>`, so recovery verification can
 * reuse the existing PBKDF2 verifier.
 *
 * Redemption flow (design §3.3 / Luồng C, `POST .../security/recover`):
 * the Recovery Service scans this user's still-valid codes with
 * `WHERE used_at IS NULL` and, on a hash match, stamps `used_at=now()`.
 * The partial `admin_backup_codes_user_unused_idx` index makes that
 * unused-code scan cheap by indexing only the rows that are still
 * spendable.
 *
 * `used_at` is monotonic: it transitions exactly once from NULL to a
 * timestamp and never back, which enforces single-use per Property 4
 * (Req 14.4, 14.7) — a consumed code can never satisfy the
 * `used_at IS NULL` predicate again. `used_from_ip` records the client
 * IP that redeemed the code for the security audit trail.
 *
 * `onDelete: 'cascade'` mirrors the policy for `login_baselines`: when
 * the owning user is removed, their backup codes have no archival value
 * and are removed with them.
 *
 * Contract: see design §3.3 and Req 14.2.
 */
export const adminBackupCodes = pgTable(
  'admin_backup_codes',
  {
    id: id(),
    /** Owning user; codes are cascade-deleted with the user. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** PBKDF2 hash of the backup code; format `pbkdf2$100000$<salt>$<hash>`. Never plaintext (Req 14.2). */
    codeHash: text('code_hash').notNull(),
    createdAt: createdAt(),
    /** NULL while spendable; stamped once on redemption (single-use, Req 14.4/14.7). */
    usedAt: timestamp('used_at'),
    /** Client IP that consumed this code, for the audit trail. */
    usedFromIp: text('used_from_ip'),
  },
  (t) => ({
    /** Partial index over spendable codes; powers the recovery `WHERE used_at IS NULL` scan. */
    userUnused: index('admin_backup_codes_user_unused_idx')
      .on(t.userId)
      .where(sql`${t.usedAt} IS NULL`),
  }),
);
