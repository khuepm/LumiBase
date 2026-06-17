import {
  bigint,
  boolean,
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

/**
 * Cross-cutting platform tables: files & folders (R2-backed), presets
 * (saved list views), translations (UI + content), settings, webhooks,
 * extensions registry.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const folders = pgTable(
  'folders',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    parent: text('parent'),
    createdAt: createdAt(),
  },
  (t) => ({
    siteIdx: index('folders_site_idx').on(t.siteId, t.parent),
  }),
);

export const files = pgTable(
  'files',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `r2` | `s3` | external URL provider. */
    storage: text('storage').default('r2').notNull(),
    filenameDisk: text('filename_disk').notNull(),
    filenameDownload: text('filename_download').notNull(),
    mime: text('mime').notNull(),
    filesize: bigint('filesize', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    duration: integer('duration'),
    folder: text('folder').references(() => folders.id),
    metadata: jsonb('metadata').default({}).notNull(),
    uploadedBy: text('uploaded_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => ({
    siteIdx: index('files_site_idx').on(t.siteId, t.folder),
  }),
);

export const presets = pgTable(
  'presets',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Null => default view for the scope; otherwise the bookmark label. */
    bookmark: text('bookmark'),
    collection: text('collection').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    roleId: text('role_id'),
    /** `tabular` | `cards` | `kanban` | `calendar` | `map` */
    layout: text('layout').default('tabular').notNull(),
    layoutQuery: jsonb('layout_query').default({}).notNull(),
    layoutOptions: jsonb('layout_options').default({}).notNull(),
    search: text('search'),
    filter: jsonb('filter').default({}).notNull(),
    icon: text('icon'),
    color: text('color'),
    /** Seconds; 0 disables auto-refresh. */
    refreshInterval: integer('refresh_interval').default(0).notNull(),
    createdAt: createdAt(),
  },
  (t) => ({
    siteCollectionIdx: index('presets_site_collection_idx').on(t.siteId, t.collection),
    scopeIdx: index('presets_scope_idx').on(t.userId, t.roleId),
  }),
);

export const translations = pgTable(
  'translations',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    language: text('language').notNull(),
    /** `ui` | `field` | `content` */
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    /** `missing` | `machine` | `draft` | `review` | `approved` */
    status: text('status').default('approved').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    unique: uniqueIndex('translations_unique').on(
      t.siteId,
      t.language,
      t.namespace,
      t.key,
    ),
  }),
);

export const settings = pgTable(
  'settings',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').default({}).notNull(),
    /** `site` | `module` */
    scope: text('scope').default('site').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteKeyUnique: uniqueIndex('settings_site_key_unique').on(t.siteId, t.key),
  }),
);

export const webhooks = pgTable(
  'webhooks',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    url: text('url').notNull(),
    actions: jsonb('actions').default([]).notNull(),
    collections: jsonb('collections').default([]).notNull(),
    headers: jsonb('headers').default({}).notNull(),
    /** `active` | `inactive` */
    status: text('status').default('active').notNull(),
    secret: text('secret'),
    createdAt: createdAt(),
  },
  (t) => ({
    siteIdx: index('webhooks_site_idx').on(t.siteId, t.status),
  }),
);

export const extensions = pgTable(
  'extensions',
  {
    id: id(),
    /** Null = globally available; otherwise scoped to a single site. */
    siteId: text('site_id').references(() => sites.id, { onDelete: 'cascade' }),
    /** Stable extension key used by access targets, import/export, and URLs. */
    key: text('key'),
    name: text('name').notNull(),
    version: text('version').notNull(),
    /** hook | endpoint | operation | interface | display | layout | panel | module */
    type: text('type').notNull(),
    enabled: boolean('enabled').default(false).notNull(),
    /** R2 path of the uploaded bundle. */
    bundleUrl: text('bundle_url').notNull(),
    manifest: jsonb('manifest').default({}).notNull(),
    /** Granted capabilities (subset of those declared in manifest). */
    capabilities: jsonb('capabilities').default([]).notNull(),
    installedBy: text('installed_by').references(() => users.id),
    installedAt: createdAt(),
    // PGA5 — Marketplace fields.
    /** Detached signature over the bundle SHA-256, base64-encoded. */
    signature: text('signature'),
    /** Algorithm used (e.g. `ed25519`, `rsa-pss-sha256`). */
    signatureAlg: text('signature_alg'),
    /** Public key id used to sign — looked up against the marketplace registry. */
    publisherKeyId: text('publisher_key_id'),
    /** Marketplace publisher (organization). */
    publisher: text('publisher'),
    /** Marketplace listing slug, used to build the public detail page URL. */
    marketplaceSlug: text('marketplace_slug'),
    /** When the extension was published to the marketplace (null = unpublished). */
    publishedAt: timestamp('published_at'),
    /** SHA-256 of the bundle for integrity verification at install time. */
    bundleSha256: text('bundle_sha256'),
  },
  (t) => ({
    siteNameIdx: index('extensions_site_name_idx').on(t.siteId, t.name),
    siteKeyIdx: index('extensions_site_key_idx').on(t.siteId, t.key),
    publisherIdx: index('extensions_publisher_idx').on(t.publisher, t.publishedAt),
    marketplaceSlugIdx: index('extensions_marketplace_slug_idx').on(t.marketplaceSlug),
  }),
);


// ---------------------------------------------------------------------------
// Email templates + layouts (email-service feature).
// ---------------------------------------------------------------------------

/**
 * Reusable HTML shells for email. A layout's `html` carries a `{{content}}`
 * slot that the render engine (`apps/cms/src/services/email/render.ts`) fills
 * with a template's rendered body, so branding (header/footer/styles) lives in
 * one place and templates stay focused on their message.
 */
export const emailLayouts = pgTable(
  'email_layouts',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Stable per-site key (e.g. `default`). */
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** HTML shell containing a `{{content}}` slot. */
    html: text('html').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteKeyUnique: uniqueIndex('email_layouts_site_key_unique').on(t.siteId, t.key),
  }),
);

/**
 * Email templates. Each row is an addressable message (`key`, e.g.
 * `teammate_invite`) with a subject + HTML body, optionally wrapped in an
 * {@link emailLayouts} shell. `variables` declares the placeholder names the
 * body/subject reference, used by the Studio UI for hints and by the render
 * engine for missing-variable warnings.
 */
export const emailTemplates = pgTable(
  'email_templates',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Stable per-site key callers send by (e.g. `teammate_invite`). */
    key: text('key').notNull(),
    name: text('name').notNull(),
    /** Optional layout wrapper. */
    layoutId: text('layout_id').references(() => emailLayouts.id, {
      onDelete: 'set null',
    }),
    subject: text('subject').notNull(),
    bodyHtml: text('body_html').notNull(),
    /** Optional explicit text body; derived from HTML when null. */
    bodyText: text('body_text'),
    /** Declared placeholder names (string[]), for UI hints + validation. */
    variables: jsonb('variables').default([]).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteKeyUnique: uniqueIndex('email_templates_site_key_unique').on(t.siteId, t.key),
  }),
);

// ---------------------------------------------------------------------------
// PGA1 — Translation Memory + MT provider config tables.
// ---------------------------------------------------------------------------

/**
 * Translation Memory entries. Each row is a `(source, target)` pair with
 * a quality score and optional context. Used for fuzzy-match suggestions
 * during translation work and as a corpus to fine-tune MT output.
 */
export const translationMemory = pgTable(
  'translation_memory',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceLang: text('source_lang').notNull(),
    targetLang: text('target_lang').notNull(),
    sourceText: text('source_text').notNull(),
    targetText: text('target_text').notNull(),
    /** Optional context tag, e.g. `posts.title` or `glossary`. */
    context: text('context'),
    /** 0–100 quality score (TM matches above ~85 are usually safe to apply). */
    quality: integer('quality').default(100).notNull(),
    /** `human` | `mt` | `imported` */
    source: text('source').default('human').notNull(),
    /** Provider when `source = 'mt'` (e.g. `deepl`, `openai`, `workers-ai`). */
    provider: text('provider'),
    /** Hits — counter increments every time this entry is reused. */
    hits: integer('hits').default(0).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    sitePairIdx: index('tm_site_pair_idx').on(t.siteId, t.sourceLang, t.targetLang),
    contextIdx: index('tm_context_idx').on(t.siteId, t.context),
  }),
);

/**
 * Glossary entries — terminology that must be translated consistently
 * (or kept verbatim). Higher priority than fuzzy TM matches.
 */
export const glossary = pgTable(
  'glossary',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceLang: text('source_lang').notNull(),
    targetLang: text('target_lang').notNull(),
    term: text('term').notNull(),
    translation: text('translation').notNull(),
    /** `do-not-translate` | `prefer` | `forbidden` */
    rule: text('rule').default('prefer').notNull(),
    note: text('note'),
    createdAt: createdAt(),
  },
  (t) => ({
    sitePairIdx: index('glossary_site_pair_idx').on(t.siteId, t.sourceLang, t.targetLang),
    termIdx: index('glossary_term_idx').on(t.siteId, t.term),
  }),
);
