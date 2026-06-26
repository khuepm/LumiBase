import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * Compliance-support tables that are not tied to a single domain feature.
 *
 * - `email_suppressions` — opt-out / suppression list for commercial email
 *   (CAN-SPAM, ePrivacy). A recipient on this list must not receive marketing
 *   mail. Keyed by normalized (lower-cased) email per site.
 * - `processing_restrictions` — restriction of processing (GDPR Art. 18). When
 *   a user is restricted, services must stop processing their data beyond mere
 *   storage (e.g. no marketing, agents skip their content).
 *
 * Note: account erasure (GDPR Art. 17) lives in the `regulated` schema
 * (`erasure_requests`) shipped by the regulated-content-readiness feature.
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

export const processingRestrictions = pgTable(
  'processing_restrictions',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Whether processing is currently restricted for this user. */
    restricted: boolean('restricted').default(false).notNull(),
    /** Free-form reason supplied with the request. */
    reason: text('reason'),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => ({
    userUnique: uniqueIndex('processing_restrictions_site_user_unique').on(t.siteId, t.userId),
    siteIdx: index('processing_restrictions_site_idx').on(t.siteId),
  }),
);
