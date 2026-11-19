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

/**
 * Install plans (#903, BT03). A plan pins one exact revision snapshot, the
 * namespace mapping, the seed choice and the target schema fingerprint; it is
 * metadata only (planning never writes schema or content) and expires.
 * `site_id` is the TARGET site. Plan ids are not bearer authorization: every
 * use re-checks the caller.
 */
export const backendTemplatePlans = pgTable(
  'lumibase_backend_template_plans',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `official` | `site`. */
    sourceKind: text('source_kind').notNull(),
    /** Catalog site of a private template; null for official templates. */
    sourceSiteId: text('source_site_id'),
    slug: text('slug').notNull(),
    templateVersion: text('template_version').notNull(),
    digest: text('digest').notNull(),
    /** The resolved revision document, as published (immutable snapshot). */
    snapshot: jsonb('snapshot').notNull(),
    /** Template collection name → target collection name. */
    namespaceMap: jsonb('namespace_map').notNull(),
    /** Chosen seed pack, or null for schema only. */
    seedPack: text('seed_pack'),
    /** sha256 of the target's schema when the plan was made. */
    targetFingerprint: text('target_fingerprint').notNull(),
    /** Components, counts and prerequisites shown to the caller. */
    inventory: jsonb('inventory').notNull(),
    /** planned → awaiting_approval → applying → completed; invalidated | expired | denied | failed. */
    status: text('status').default('planned').notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    siteStatusIdx: index('backend_template_plans_site_status_idx').on(t.siteId, t.status),
  }),
);
