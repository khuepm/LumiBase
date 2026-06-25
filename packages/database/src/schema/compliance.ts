import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * Compliance-support tables that are not tied to a single domain feature.
 *
 * - `email_suppressions` — opt-out / suppression list for commercial email
 *   (CAN-SPAM, ePrivacy). A recipient on this list must not receive marketing
 *   mail. Keyed by normalized (lower-cased) email per site.
 * - `erasure_requests` — right-to-be-forgotten (GDPR Art. 17) tracking. A
 *   pending request records the grace-period deadline; a background processor
 *   anonymizes the account when `scheduled_at` passes.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Normalized (trimmed, lower-cased) email address. */
    emailLower: text('email_lower').notNull(),
    /** `unsubscribe` | `bounce` | `complaint` | `manual` */
    reason: text('reason').default('unsubscribe').notNull(),
    /** Free-form provenance, e.g. `one_click`, `preference_center`, `import`. */
    source: text('source'),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteEmailUnique: uniqueIndex('email_suppressions_site_email_unique').on(
      t.siteId,
      t.emailLower,
    ),
    siteIdx: index('email_suppressions_site_idx').on(t.siteId),
  }),
);

export const erasureRequests = pgTable(
  'erasure_requests',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Email at request time, kept for the audit trail after anonymization. */
    emailSnapshot: text('email_snapshot'),
    /** `pending` | `completed` | `cancelled` */
    status: text('status').default('pending').notNull(),
    /** `self` (user-initiated) | `admin` */
    requestedByType: text('requested_by_type').default('self').notNull(),
    /** When the grace period ends and the account may be anonymized. */
    scheduledAt: timestamp('scheduled_at').notNull(),
    /** When anonymization actually completed. */
    completedAt: timestamp('completed_at'),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => ({
    userUnique: uniqueIndex('erasure_requests_site_user_unique').on(t.siteId, t.userId),
    siteStatusIdx: index('erasure_requests_site_status_idx').on(t.siteId, t.status),
    scheduledIdx: index('erasure_requests_scheduled_idx').on(t.status, t.scheduledAt),
  }),
);
