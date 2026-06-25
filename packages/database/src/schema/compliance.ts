import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Compliance-support tables that are not tied to a single domain feature.
 *
 * - `email_suppressions` — opt-out / suppression list for commercial email
 *   (CAN-SPAM, ePrivacy). A recipient on this list must not receive marketing
 *   mail. Keyed by normalized (lower-cased) email per site.
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
