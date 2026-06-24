import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * Consent management (GDPR Art. 7, Vietnam PDPD). One current-state row per
 * `(site_id, user_id, consent_type)`. The full history of grants/withdrawals
 * is captured in `audit_log` (the route writes a `consent_granted` /
 * `consent_withdrawn` event on every change), so this table only needs to hold
 * the latest decision plus when it was last granted/withdrawn.
 *
 * Legally significant consent is kept here, NOT in the free-form
 * `users.preferences` JSONB, so it can be queried, audited and enforced (e.g.
 * the email send path checks `marketing` before dispatching).
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const userConsents = pgTable(
  'user_consents',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `marketing` | `analytics` | `personalization` | `functional` */
    consentType: text('consent_type').notNull(),
    /** Current decision. `true` = granted, `false` = withdrawn/denied. */
    granted: boolean('granted').default(false).notNull(),
    /** When consent was last granted (null if never granted). */
    grantedAt: timestamp('granted_at'),
    /** When consent was last withdrawn (null if currently granted). */
    withdrawnAt: timestamp('withdrawn_at'),
    /** Where the decision came from, e.g. `preference_center`, `signup`, `import`. */
    source: text('source'),
    /** Version of the privacy notice / consent text the user agreed to. */
    version: text('version'),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => ({
    userTypeUnique: uniqueIndex('user_consents_user_type_unique').on(
      t.siteId,
      t.userId,
      t.consentType,
    ),
    siteIdx: index('user_consents_site_idx').on(t.siteId),
    userIdx: index('user_consents_user_idx').on(t.userId),
  }),
);
