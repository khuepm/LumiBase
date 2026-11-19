import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Background collection imports (#726, epic #673 I01).
 *
 * One row per uploaded file. A worker claims the row with a short lease,
 * processes the next chunk of rows from `cursor`, records counters and
 * row-level errors, and releases it; a cron tick resumes any job whose lease
 * expired (Worker eviction, process restart). Cancel is a flag checked between
 * chunks; timeout is `started_at + timeout_ms`.
 *
 * The upload is parsed once, when the job is created, and staged as
 * `lumibase_import_chunks` rows; a step reads only the chunk at `cursor`
 * (#859). `source` is no longer written: it only holds the raw file of a job
 * queued before staging existed, which its next step stages and clears.
 * Read paths must never select it (`importJobColumns` in the CMS).
 */
export const importJobs = pgTable(
  'lumibase_import_jobs',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    /** `csv` | `json` (the `lumibase-export@1` envelope or a bare array). */
    format: text('format').notNull(),
    /** `create` (always new items) | `upsert` (update by `id` when it exists). */
    mode: text('mode').default('create').notNull(),
    /** `queued` | `running` | `succeeded` | `failed` | `cancelled` | `timed_out` */
    status: text('status').default('queued').notNull(),
    /**
     * Who asked for the import (`AuthenticatedPrincipalRef`). The worker
     * re-resolves it at every chunk, so a revoked grant stops the job.
     */
    principal: jsonb('principal').notNull(),
    createdBy: text('created_by'),
    source: text('source').default('').notNull(),
    sourceBytes: integer('source_bytes').default(0).notNull(),
    totalRows: integer('total_rows').default(0).notNull(),
    /** Next row index to process (0-based). */
    cursor: integer('cursor').default(0).notNull(),
    createdRows: integer('created_rows').default(0).notNull(),
    updatedRows: integer('updated_rows').default(0).notNull(),
    failedRows: integer('failed_rows').default(0).notNull(),
    /** `{ row, id?, message }[]`, capped; `errors_truncated` counts the rest. */
    errors: jsonb('errors').default([]).notNull(),
    errorsTruncated: integer('errors_truncated').default(0).notNull(),
    /** Failure / cancel / timeout reason for the whole job. */
    message: text('message'),
    timeoutMs: integer('timeout_ms').notNull(),
    cancelRequestedAt: timestamp('cancel_requested_at'),
    leaseOwner: text('lease_owner'),
    leaseUntil: timestamp('lease_until'),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => ({
    siteStatusIdx: index('import_jobs_site_status_idx').on(t.siteId, t.status, t.createdAt),
    leaseIdx: index('import_jobs_status_lease_idx').on(t.status, t.leaseUntil),
  }),
);

/**
 * Parsed rows of an import, staged in chunks (#859). Written once when the job
 * is created; the worker reads the chunk that starts at the job's `cursor` and
 * deletes it in the same transaction that advances the cursor. Whatever is
 * left is deleted when the job ends (and cascades with the job and the site).
 */
export const importChunks = pgTable(
  'lumibase_import_chunks',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => importJobs.id, { onDelete: 'cascade' }),
    /** 0-based index of the first row in this chunk. */
    startRow: integer('start_row').notNull(),
    rowCount: integer('row_count').notNull(),
    /** `ImportRecord[]` (`{ id?, status?, sort?, data }`), already parsed. */
    records: jsonb('records').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => ({
    jobStartUnique: uniqueIndex('import_chunks_job_start_unique').on(t.jobId, t.startRow),
  }),
);
