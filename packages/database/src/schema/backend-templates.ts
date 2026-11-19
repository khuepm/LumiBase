import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * Backend template catalog (#902, epic #900; spec .kiro/specs/backend-templates/).
 *
 * A site's PRIVATE templates: an editable draft per slug, and immutable,
 * content-addressed published revisions. Official templates ship read-only in
 * the application bundle and are never stored here. Every row carries
 * `site_id`; uniqueness always includes it, and both tables are in the
 * `site_isolation` RLS list.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();

export const backendTemplates = pgTable(
  'lumibase_backend_templates',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Stable template slug (`lumibase.template@v1` `slug`); fixed at creation. */
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    /** The editable draft document (JSON). May be invalid while being edited. */
    draft: jsonb('draft').notNull(),
    /** Optimistic-concurrency counter: every draft edit must name the revision it read. */
    draftRevision: integer('draft_revision').default(1).notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    siteSlugUnique: uniqueIndex('backend_templates_site_slug_unique').on(t.siteId, t.slug),
  }),
);

/** One published, immutable revision of a template. Never updated or deleted by the API. */
export const backendTemplateRevisions = pgTable(
  'lumibase_backend_template_revisions',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    templateId: text('template_id')
      .notNull()
      .references(() => backendTemplates.id, { onDelete: 'restrict' }),
    /** SemVer `templateVersion` of the published document. */
    templateVersion: text('template_version').notNull(),
    /** `sha256:<hex>` of the canonical document (content address). */
    digest: text('digest').notNull(),
    /** The canonical published document. */
    document: jsonb('document').notNull(),
    publishedBy: text('published_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    versionUnique: uniqueIndex('backend_template_revisions_version_unique').on(t.siteId, t.templateId, t.templateVersion),
    digestIdx: index('backend_template_revisions_digest_idx').on(t.siteId, t.digest),
  }),
);
