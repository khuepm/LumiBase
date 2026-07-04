import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';
import { items } from './cms';

/**
 * Regulated / sensitive content readiness tables (spec:
 * `.kiro/specs/regulated-content-readiness`). All are opt-in and additive;
 * default Tier 1 installations never write to them.
 *
 * ID convention: the existing `audit_log` uses a nanoid primary key, so for
 * consistency every table here (domain and audit-grade) uses nanoid via the
 * shared `id()` helper rather than introducing a uuidv7 dependency the
 * codebase does not otherwise use.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();

/**
 * `encryption_keys` — metadata only for key versioning/rotation (Req 3.3).
 * Never stores key material; the actual bytes live in the runtime KeyProvider
 * (Workers Secrets / env). `siteId` null denotes a global key.
 */
export const encryptionKeys = pgTable(
  'lumibase_encryption_keys',
  {
    id: id(),
    siteId: text('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    /** Version id embedded in the ciphertext envelope (e.g. `v1`). */
    keyId: text('key_id').notNull(),
    /** `active` (encrypt new) | `retired` (decrypt only). */
    status: text('status').default('active').notNull(),
    algo: text('algo').default('AES-GCM').notNull(),
    createdAt: createdAt(),
    retiredAt: timestamp('retired_at'),
  },
  (t) => ({
    siteKeyUnique: uniqueIndex('encryption_keys_site_key_unique').on(t.siteId, t.keyId),
  }),
);

/**
 * `field_access_log` — audit of every decrypted read of a `pii|phi` field
 * (Req 6). Never stores the decrypted value; written in batches and
 * site-isolated by RLS.
 */
export const fieldAccessLog = pgTable(
  'lumibase_field_access_log',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    /** Affected record ids (aggregate for list reads). */
    recordIds: jsonb('record_ids').default([]).notNull(),
    /** Field names that were decrypted. */
    fields: jsonb('fields').default([]).notNull(),
    actor: text('actor'),
    action: text('action').notNull(),
    requestId: text('request_id'),
    timestamp: timestamp('timestamp').defaultNow().notNull(),
  },
  (t) => ({
    siteTsIdx: index('field_access_log_site_ts_idx').on(t.siteId, t.timestamp),
    actorTsIdx: index('field_access_log_actor_ts_idx').on(t.actor, t.timestamp),
  }),
);

/**
 * `content_reviews` — human editorial sign-off records (Req 9). `itemId` uses
 * `onDelete: set null` so review history survives erasure (Req 11.3).
 */
export const contentReviews = pgTable(
  'lumibase_content_reviews',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    itemId: text('item_id').references(() => items.id, { onDelete: 'set null' }),
    revisionId: text('revision_id'),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** Assigned reviewer — user id or role token. */
    assignedTo: text('assigned_to'),
    /** `pending | approved | rejected`. */
    status: text('status').default('pending').notNull(),
    reason: text('reason'),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at'),
    createdAt: createdAt(),
  },
  (t) => ({
    siteStatusIdx: index('content_reviews_site_status_idx').on(t.siteId, t.status),
    assignedIdx: index('content_reviews_assigned_idx').on(t.siteId, t.assignedTo),
  }),
);

/**
 * `erasure_requests` — GDPR right-to-erasure lifecycle (Req 11). Stores a hash
 * of the subject identifier, never plaintext, and supports dual-control.
 */
export const erasureRequests = pgTable(
  'lumibase_erasure_requests',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `{ collection, filter }` describing the erasure scope. */
    scope: jsonb('scope').default({}).notNull(),
    /** Hash of the subject identifier (never plaintext). */
    subjectHash: text('subject_hash'),
    reason: text('reason'),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    /** Second admin for dual-control confirmation (Req 11.4). */
    confirmedBy: text('confirmed_by').references(() => users.id, { onDelete: 'set null' }),
    /** `pending | confirmed | executing | completed | failed`. */
    status: text('status').default('pending').notNull(),
    recordCount: integer('record_count').default(0).notNull(),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at'),
  },
  (t) => ({
    siteStatusIdx: index('erasure_requests_site_status_idx').on(t.siteId, t.status),
  }),
);
