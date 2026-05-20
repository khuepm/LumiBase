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
  },
  (t) => ({
    siteNameIdx: index('extensions_site_name_idx').on(t.siteId, t.name),
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
