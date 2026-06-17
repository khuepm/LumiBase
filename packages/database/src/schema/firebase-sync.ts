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
import { sites } from './core';

/**
 * LumiBase Firebase Sync extension tables.
 *
 * Persists outbound-sync pipeline configurations that mirror LumiBase content
 * (`items`) into a Firebase target — Cloud Firestore or the Realtime Database —
 * plus an append-only log of each sync attempt for observability.
 *
 * The Firebase service-account JSON (or RTDB secret) is stored ENCRYPTED in
 * {@link lumibaseFirebaseSyncPipelines.credentialsEncrypted} via the app's
 * `CryptoService` (AES-GCM). Nothing here ever holds plaintext credentials.
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const lumibaseFirebaseSyncPipelines = pgTable(
  'lumibase_firebase_sync_pipelines',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Firebase target service: 'firestore' | 'rtdb'. */
    target: text('target').notNull(),
    /** 'active' | 'paused' | 'error'. */
    status: text('status').default('active').notNull(),
    statusMessage: text('status_message'),
    /** Firebase project id (used to build REST URLs). */
    projectId: text('project_id').notNull(),
    /**
     * Encrypted credential blob (AES-GCM via CryptoService).
     * Firestore: a service-account JSON. RTDB: { databaseUrl, secret }.
     */
    credentialsEncrypted: text('credentials_encrypted').notNull(),
    /**
     * LumiBase collection machine-names to mirror. Empty array = all
     * collections on the site.
     */
    collections: jsonb('collections').default([]).notNull(),
    /**
     * Target path template. For Firestore the destination collection/path
     * (e.g. `content/{collection}`); for RTDB the JSON ref prefix. `{collection}`
     * and `{itemId}` placeholders are interpolated at sync time.
     */
    targetPath: text('target_path').default('{collection}').notNull(),
    /** Which item actions trigger a sync. */
    syncOnCreate: integer('sync_on_create').default(1).notNull(),
    syncOnUpdate: integer('sync_on_update').default(1).notNull(),
    syncOnDelete: integer('sync_on_delete').default(1).notNull(),
    lastSyncAt: timestamp('last_sync_at'),
    lastSyncItemCount: integer('last_sync_item_count'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    siteNameUnique: uniqueIndex('lumibase_firebase_sync_site_name_unique').on(
      t.siteId,
      t.name,
    ),
    siteStatusIdx: index('lumibase_firebase_sync_site_status_idx').on(
      t.siteId,
      t.status,
    ),
  }),
);

export const lumibaseFirebaseSyncLog = pgTable(
  'lumibase_firebase_sync_log',
  {
    id: id(),
    pipelineId: text('pipeline_id')
      .notNull()
      .references(() => lumibaseFirebaseSyncPipelines.id, {
        onDelete: 'cascade',
      }),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    itemId: text('item_id').notNull(),
    /** 'create' | 'update' | 'delete'. */
    action: text('action').notNull(),
    /** 'success' | 'error'. */
    result: text('result').notNull(),
    errorMessage: text('error_message'),
    /** Round-trip duration of the Firebase REST call, in milliseconds. */
    durationMs: integer('duration_ms'),
    recordedAt: timestamp('recorded_at').defaultNow().notNull(),
  },
  (t) => ({
    pipelineTimeIdx: index('lumibase_firebase_sync_log_pipeline_time_idx').on(
      t.pipelineId,
      t.recordedAt,
    ),
  }),
);
