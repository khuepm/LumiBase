/**
 * Background collection imports (#726, epic #673 I01).
 *
 * An upload becomes a row in `lumibase_import_jobs`; workers then process it
 * in chunks under a short lease:
 *
 *   createImportJob   validate + parse once (400 on a bad file), stage the
 *                     parsed rows as chunks, queue
 *   runImportStep     claim → check cancel/timeout → re-resolve principal →
 *                     load the staged chunk at the cursor → write it →
 *                     record counters/errors, drop the chunk → release
 *   driveImportJob    loop steps within a time budget (request `waitUntil`)
 *   runImportTick     cron: resume jobs whose lease expired, round-robin and
 *                     fair per site, honouring the per-site concurrency limit
 *
 * Every row goes through `ItemService` bound to the job's principal, so
 * validation, permissions, hooks, revisions and CDC behave exactly as for a
 * normal create/update. The principal is re-resolved at every step, so a
 * revoked grant or deleted key stops the job.
 *
 * Works the same on Workers and Node: the only moving parts are SQL updates
 * guarded on `lease_until`, so overlapping ticks never process a chunk twice.
 *
 * Memory (#859): the file is parsed once, at create. A step loads one staged
 * chunk, never the whole file, and job reads project `importJobColumns`, which
 * leaves out the legacy `source` column.
 */
import { and, asc, eq, getTableColumns, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { importChunks, importJobs, type Database } from '@lumibase/database';
import type { RealtimeProvider } from '@lumibase/runtime';
import { nanoid } from 'nanoid';
import { ExportError, parseExport, type ExportFormat, type ImportRecord } from './export-service';
import { EffectiveCapabilityService, type AuthenticatedPrincipalRef } from './effective-capability-service';
import { resolvePrincipalCapabilities } from './governed-capabilities';
import { itemServiceForPrincipal } from './item-service-factory';
import { ItemServiceError, type ItemService } from './item-service';
import type { CompiledField } from './schema-service';

export type ImportMode = 'create' | 'upsert';
export type ImportStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
export const TERMINAL_STATUSES: readonly ImportStatus[] = ['succeeded', 'failed', 'cancelled', 'timed_out'];

export interface ImportRowError {
  /** 1-based data row (CSV: line after the header; JSON: position in `items`). */
  row: number;
  id?: string;
  message: string;
}

export interface ImportConfig {
  /** Whole-job wall-clock budget. `IMPORT_TIMEOUT` (seconds), default 3600. */
  timeoutMs: number;
  /** Jobs running at once per site. `IMPORT_MAX_CONCURRENCY`, default 20. */
  maxConcurrency: number;
  /** Largest accepted upload. `IMPORT_MAX_BYTES`, default 50 MiB. */
  maxBytes: number;
  /** Rows written per step. `IMPORT_CHUNK_SIZE`, default 500. */
  chunkSize: number;
  /**
   * Bytes of uploads a site may have queued or running at once.
   * `IMPORT_MAX_PENDING_BYTES`, default 200 MiB; never below `maxBytes`.
   */
  maxPendingBytes: number;
  /** Jobs a site may have queued or running at once. `IMPORT_MAX_PENDING_JOBS`, default 100. */
  maxPendingJobs: number;
  /** Row errors kept in the report; the rest are only counted. */
  maxErrors: number;
  /** How long a step may hold a job before another worker can take it. */
  leaseMs: number;
}

export const DEFAULT_IMPORT_CONFIG: ImportConfig = {
  timeoutMs: 3600_000,
  maxConcurrency: 20,
  maxBytes: 50 * 1024 * 1024,
  chunkSize: 500,
  maxPendingBytes: 200 * 1024 * 1024,
  maxPendingJobs: 100,
  maxErrors: 1000,
  leaseMs: 120_000,
};

function positiveInt(raw: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** Read the import knobs from env vars (Workers bindings or `process.env`). */
export function resolveImportConfig(env: Record<string, string | undefined>): ImportConfig {
  const maxBytes = positiveInt(env.IMPORT_MAX_BYTES, DEFAULT_IMPORT_CONFIG.maxBytes, 1024 * 1024 * 1024);
  return {
    ...DEFAULT_IMPORT_CONFIG,
    timeoutMs: positiveInt(env.IMPORT_TIMEOUT, DEFAULT_IMPORT_CONFIG.timeoutMs / 1000, 7 * 24 * 3600) * 1000,
    maxConcurrency: positiveInt(env.IMPORT_MAX_CONCURRENCY, DEFAULT_IMPORT_CONFIG.maxConcurrency, 1000),
    maxBytes,
    chunkSize: positiveInt(env.IMPORT_CHUNK_SIZE, DEFAULT_IMPORT_CONFIG.chunkSize, 5000),
    // A pending budget smaller than one upload would refuse every file.
    maxPendingBytes: Math.max(
      maxBytes,
      positiveInt(env.IMPORT_MAX_PENDING_BYTES, DEFAULT_IMPORT_CONFIG.maxPendingBytes, 16 * 1024 * 1024 * 1024),
    ),
    maxPendingJobs: positiveInt(env.IMPORT_MAX_PENDING_JOBS, DEFAULT_IMPORT_CONFIG.maxPendingJobs, 10_000),
  };
}

export class ImportError extends Error {
  constructor(
    public readonly code: 'VALIDATION' | 'PAYLOAD_TOO_LARGE' | 'NOT_FOUND' | 'CONFLICT' | 'LIMIT_EXCEEDED',
    message: string,
    public readonly status: 400 | 404 | 409 | 413 | 429 = 400,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/**
 * Every job column except `source`. Use it for every read of a job (#859):
 * `source` can hold a whole uploaded file (up to `IMPORT_MAX_BYTES`) for jobs
 * queued before staging existed, and nothing outside the staging fallback in
 * `loadChunk` needs it.
 */
export const importJobColumns = (() => {
  const { source, ...rest } = getTableColumns(importJobs);
  void source;
  return rest;
})();

/** A job row as read through `importJobColumns`. */
export type ImportJobRow = Omit<typeof importJobs.$inferSelect, 'source'>;

/** One staged chunk of parsed rows. */
export interface StagedChunk {
  startRow: number;
  records: ImportRecord[];
}

/** Split parsed rows into chunks of `size`, numbered from `startRow`. */
export function chunkRecords(records: ImportRecord[], size: number, startRow = 0): StagedChunk[] {
  const out: StagedChunk[] = [];
  for (let i = 0; i < records.length; i += size) {
    out.push({ startRow: startRow + i, records: records.slice(i, i + size) });
  }
  return out;
}

/** Chunks per INSERT: bounds the statement size without one round trip per chunk. */
const CHUNKS_PER_INSERT = 10;

async function stageChunks(db: Database, siteId: string, jobId: string, chunks: StagedChunk[]): Promise<void> {
  for (let i = 0; i < chunks.length; i += CHUNKS_PER_INSERT) {
    await db.insert(importChunks).values(
      chunks.slice(i, i + CHUNKS_PER_INSERT).map((c) => ({
        siteId,
        jobId,
        startRow: c.startRow,
        rowCount: c.records.length,
        records: c.records,
      })),
    );
  }
}

/** Public shape of a job (never includes the uploaded source). */
export interface ImportJobView {
  id: string;
  collection: string;
  format: string;
  mode: string;
  status: ImportStatus;
  totalRows: number;
  processedRows: number;
  createdRows: number;
  updatedRows: number;
  failedRows: number;
  errorsTruncated: number;
  message: string | null;
  createdBy: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toJobView(row: ImportJobRow): ImportJobView {
  return {
    id: row.id,
    collection: row.collection,
    format: row.format,
    mode: row.mode,
    status: row.status as ImportStatus,
    totalRows: row.totalRows,
    processedRows: row.cursor,
    createdRows: row.createdRows,
    updatedRows: row.updatedRows,
    failedRows: row.failedRows,
    errorsTruncated: row.errorsTruncated,
    message: row.message,
    createdBy: row.createdBy,
    cancelRequested: row.cancelRequestedAt !== null,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
  };
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createImportJob(input: {
  db: Database;
  siteId: string;
  collection: string;
  format: ExportFormat;
  mode: ImportMode;
  body: string;
  schemaFields: Pick<CompiledField, 'name' | 'type' | 'interface'>[];
  principal: AuthenticatedPrincipalRef;
  createdBy: string | null;
  config: ImportConfig;
}): Promise<ImportJobRow> {
  const bytes = new TextEncoder().encode(input.body).byteLength;
  if (bytes > input.config.maxBytes) {
    throw new ImportError('PAYLOAD_TOO_LARGE', `Import file exceeds the ${input.config.maxBytes} byte limit.`, 413);
  }
  let records: ImportRecord[];
  try {
    records = parseExport(input.body, input.format, input.schemaFields);
  } catch (err) {
    if (err instanceof ExportError) throw new ImportError('VALIDATION', err.message);
    throw err;
  }
  if (records.length === 0) throw new ImportError('VALIDATION', 'The file has no rows to import.');
  const chunks = chunkRecords(records, input.config.chunkSize);

  return input.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    // Serialise creates per site so two uploads cannot both pass the budget check.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lumibase_import:${input.siteId}`}, 0))`);
    const [pending] = (await db
      .select({
        jobs: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(${importJobs.sourceBytes}), 0)::bigint`,
      })
      .from(importJobs)
      .where(and(eq(importJobs.siteId, input.siteId), inArray(importJobs.status, ['queued', 'running'])))) as [
      { jobs: number; bytes: number | string },
    ];
    if (pending.jobs >= input.config.maxPendingJobs) {
      throw new ImportError(
        'LIMIT_EXCEEDED',
        `This site already has ${pending.jobs} imports queued or running (limit ${input.config.maxPendingJobs}). Wait for one to finish.`,
        429,
      );
    }
    if (Number(pending.bytes) + bytes > input.config.maxPendingBytes) {
      throw new ImportError(
        'LIMIT_EXCEEDED',
        `Imports queued or running on this site would exceed ${input.config.maxPendingBytes} bytes. Wait for one to finish.`,
        429,
      );
    }

    const [row] = await db
      .insert(importJobs)
      .values({
        siteId: input.siteId,
        collection: input.collection,
        format: input.format,
        mode: input.mode,
        status: 'queued',
        principal: input.principal,
        createdBy: input.createdBy,
        sourceBytes: bytes,
        totalRows: records.length,
        timeoutMs: input.config.timeoutMs,
      })
      .returning(importJobColumns);
    await stageChunks(db, input.siteId, row!.id, chunks);
    return row!;
  });
}

// ── Step ──────────────────────────────────────────────────────────────────────

/** Builds an ItemService bound to the job's principal on a given connection/transaction. */
export type ItemServiceBinder = (db: Database) => ItemService;

export interface ImportStepDeps {
  db: Database;
  config: ImportConfig;
  realtime?: RealtimeProvider;
  /**
   * Runtime env (Workers bindings or `process.env`). Passed to ItemService as
   * `extensionEnv` so hook extensions run on imported rows.
   */
  env?: Record<string, unknown>;
  /** Injectable for tests; defaults to the real principal-bound ItemService. */
  itemServiceFor?: (job: ImportJobRow) => Promise<ItemServiceBinder | { denied: string }>;
  /**
   * Test seam: runs inside the chunk transaction after each row is written.
   * Throwing here simulates a crash mid-chunk (the whole chunk rolls back).
   */
  afterRowWritten?: (rowIndex: number) => Promise<void> | void;
  now?: () => Date;
}

export type StepOutcome = 'progressed' | 'done' | 'busy' | 'waiting';

async function defaultItemServiceFor(
  db: Database,
  job: ImportJobRow,
  env: Record<string, unknown> | undefined,
): Promise<ItemServiceBinder | { denied: string }> {
  const resolution = await resolvePrincipalCapabilities(
    new EffectiveCapabilityService({ db, siteId: job.siteId }),
    job.principal as AuthenticatedPrincipalRef,
  );
  if (!resolution.allowed || !resolution.permissionContext) {
    return { denied: resolution.message ?? 'The principal that started this import is no longer authorised.' };
  }
  const ctx = resolution.permissionContext;
  return (bound) =>
    itemServiceForPrincipal(
      { db: bound, siteId: job.siteId, userId: job.createdBy ?? null, ...(env ? { extensionEnv: env } : {}) },
      ctx,
    );
}

/** Transaction-scoped advisory lock serialising job starts within one site. */
function importSiteLock(siteId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`lumibase_import:${siteId}`}, 0))`;
}

/** Thrown inside the chunk transaction when another worker owns the job. */
class LeaseLostError extends Error {}

function rowError(row: number, rec: ImportRecord, err: unknown): ImportRowError {
  const message =
    err instanceof ItemServiceError || err instanceof Error ? err.message : 'Unexpected error while writing the row.';
  return { row, ...(rec.id ? { id: rec.id } : {}), message: message.slice(0, 500) };
}

async function publishProgress(deps: ImportStepDeps, job: ImportJobRow): Promise<void> {
  if (!deps.realtime?.isAvailable()) return;
  try {
    await deps.realtime.publish(job.siteId, {
      type: 'event',
      plane: 'studio',
      ...(job.createdBy ? { target: { userId: job.createdBy } } : {}),
      collection: job.collection,
      // Counters only — never row data (subscribers re-fetch under their own RBAC).
      payload: { kind: 'import.progress', job: toJobView(job) },
    });
  } catch {
    /* progress fan-out is best-effort; Studio also polls */
  }
}

/** Finish a job: set a terminal status, drop staged rows, release the lease. */
async function finish(
  deps: ImportStepDeps,
  jobId: string,
  owner: string,
  status: ImportStatus,
  message: string | null,
  extra: Partial<typeof importJobs.$inferInsert> = {},
): Promise<ImportJobRow | undefined> {
  const now = deps.now?.() ?? new Date();
  const [row] = await deps.db
    .update(importJobs)
    .set({
      ...extra,
      status,
      message,
      source: '',
      finishedAt: now,
      updatedAt: now,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(and(eq(importJobs.id, jobId), eq(importJobs.leaseOwner, owner)))
    .returning(importJobColumns);
  if (row) {
    await deps.db.delete(importChunks).where(eq(importChunks.jobId, jobId));
    await publishProgress(deps, row);
  }
  return row;
}

/**
 * The staged rows that start at the job's cursor. A job queued before staging
 * existed (#859) still has its raw file in `source` and no chunks: parse it
 * once here, stage what is left, and clear `source`. The only place that
 * reads `source`.
 */
async function loadChunk(
  deps: ImportStepDeps,
  job: ImportJobRow,
  owner: string,
  fields: Pick<CompiledField, 'name' | 'type' | 'interface'>[],
): Promise<ImportRecord[]> {
  const [found] = await deps.db
    .select({ records: importChunks.records })
    .from(importChunks)
    .where(and(eq(importChunks.jobId, job.id), eq(importChunks.startRow, job.cursor)))
    .limit(1);
  if (found) return found.records as ImportRecord[];

  const [legacy] = await deps.db
    .select({ source: importJobs.source })
    .from(importJobs)
    .where(and(eq(importJobs.id, job.id), eq(importJobs.leaseOwner, owner)))
    .limit(1);
  if (!legacy?.source) throw new Error('The staged rows of this import are missing.');
  const rest = parseExport(legacy.source, job.format as ExportFormat, fields).slice(job.cursor);
  if (rest.length === 0) throw new Error('The import file has no rows left to import.');
  const chunks = chunkRecords(rest, deps.config.chunkSize, job.cursor);
  // The schema may have changed since upload; the rows parsed now are the job.
  job.totalRows = job.cursor + rest.length;
  await deps.db.transaction(async (tx) => {
    await stageChunks(tx as unknown as Database, job.siteId, job.id, chunks);
    await tx
      .update(importJobs)
      .set({ source: '', totalRows: job.totalRows })
      .where(and(eq(importJobs.id, job.id), eq(importJobs.leaseOwner, owner)));
  });
  return chunks[0]!.records;
}

/**
 * Process one chunk of `jobId`. Returns `busy` when another worker holds the
 * lease, `waiting` when the site is at its concurrency limit, `done` when the
 * job reached a terminal state, else `progressed`.
 */
export async function runImportStep(deps: ImportStepDeps, jobId: string): Promise<StepOutcome> {
  const now = deps.now?.() ?? new Date();
  const owner = nanoid();
  const leaseUntil = new Date(now.getTime() + deps.config.leaseMs);

  const [current] = await deps.db.select(importJobColumns).from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
  if (!current) return 'done';
  if (TERMINAL_STATUSES.includes(current.status as ImportStatus)) return 'done';

  // Claim: only when nobody holds a live lease.
  const claim = async (db: Database): Promise<ImportJobRow | undefined> => {
    const [row] = await db
      .update(importJobs)
      .set({
        leaseOwner: owner,
        leaseUntil,
        status: sql`case when ${importJobs.status} = 'queued' then 'running' else ${importJobs.status} end`,
        startedAt: sql`coalesce(${importJobs.startedAt}, ${now.toISOString()}::timestamp)`,
        updatedAt: now,
      })
      .where(
        and(
          eq(importJobs.id, jobId),
          inArray(importJobs.status, ['queued', 'running']),
          or(isNull(importJobs.leaseUntil), lt(importJobs.leaseUntil, now)),
        ),
      )
      .returning(importJobColumns);
    return row;
  };

  let job: ImportJobRow | undefined;
  if (current.status === 'queued' && current.cancelRequestedAt === null) {
    // Starting a job counts against the per-site limit. The count and the
    // claim must be one atomic decision, or parallel steps for different
    // queued jobs all read a count below the limit and all claim (#860). A
    // per-site transaction-scoped advisory lock serialises those decisions;
    // under READ COMMITTED each statement after the lock sees every claim the
    // previous holder committed.
    const decision = await deps.db.transaction(async (tx) => {
      await tx.execute(importSiteLock(current.siteId));
      const [{ running }] = (await tx
        .select({ running: sql<number>`count(*)::int` })
        .from(importJobs)
        .where(and(eq(importJobs.siteId, current.siteId), eq(importJobs.status, 'running')))) as [{ running: number }];
      if (running >= deps.config.maxConcurrency) return 'waiting' as const;
      return claim(tx as unknown as Database);
    });
    if (decision === 'waiting') return 'waiting';
    job = decision;
  } else {
    job = await claim(deps.db);
  }
  if (!job) return 'busy';

  if (job.cancelRequestedAt) {
    await finish(deps, job.id, owner, 'cancelled', 'Cancelled by request.');
    return 'done';
  }
  if (job.startedAt && now.getTime() - job.startedAt.getTime() > job.timeoutMs) {
    await finish(deps, job.id, owner, 'timed_out', `Stopped after the ${Math.round(job.timeoutMs / 1000)} s import timeout.`);
    return 'done';
  }

  const bind = await (deps.itemServiceFor ?? ((j) => defaultItemServiceFor(deps.db, j, deps.env)))(job);
  if ('denied' in bind) {
    await finish(deps, job.id, owner, 'failed', bind.denied);
    return 'done';
  }

  let records: ImportRecord[];
  try {
    const meta = await bind(deps.db).describeForExport(job.collection);
    records = await loadChunk(deps, job, owner, meta.fields);
  } catch (err) {
    await finish(deps, job.id, owner, 'failed', err instanceof Error ? err.message : 'Could not read the import file.');
    return 'done';
  }

  // ── One transaction per chunk ─────────────────────────────────────────────
  //
  // The rows and the cursor advance commit together, so a crash anywhere in
  // the chunk rolls back every row it wrote and the next worker replays the
  // chunk from the old cursor: no duplicates (review on #792).
  //
  // Fencing: the transaction first locks the job row `FOR UPDATE` where we are
  // still the lease owner, and renews the lease. A competing claim blocks on
  // that lock until we commit or roll back, so two workers can never write the
  // same chunk; if another worker took the job before we locked it, we write
  // nothing. If this process dies, Postgres aborts the transaction and drops
  // the lock, and the expired lease lets the next tick resume.
  const start = job.cursor;
  const end = Math.min(start + records.length, job.totalRows);
  let committed: ImportJobRow | undefined;
  try {
    committed = await deps.db.transaction(async (tx) => {
      const lockedAt = deps.now?.() ?? new Date();
      const [locked] = await tx
        .select({ id: importJobs.id })
        .from(importJobs)
        .where(and(eq(importJobs.id, job.id), eq(importJobs.leaseOwner, owner)))
        .for('update');
      if (!locked) throw new LeaseLostError();
      await tx
        .update(importJobs)
        .set({ leaseUntil: new Date(lockedAt.getTime() + deps.config.leaseMs) })
        .where(eq(importJobs.id, job.id));

      const svc = bind(tx as unknown as Database);
      let created = 0;
      let updated = 0;
      const errors: ImportRowError[] = [];
      for (let i = start; i < end; i++) {
        const rec = records[i - start]!;
        try {
          // Savepoint per row: a failing row rolls back only its own writes.
          await tx.transaction(async () => {
            const payload = { data: rec.data, ...(rec.status ? { status: rec.status } : {}), ...(rec.sort !== undefined ? { sort: rec.sort } : {}) };
            if (job.mode === 'upsert' && rec.id && (await exists(svc, job.collection, rec.id))) {
              await svc.patch(job.collection, rec.id, payload);
              updated++;
            } else {
              await svc.create(job.collection, payload);
              created++;
            }
          });
        } catch (err) {
          errors.push(rowError(i + 1, rec, err));
        }
        // Outside the per-row catch: a throw here aborts the whole chunk.
        await deps.afterRowWritten?.(i);
      }

      const keptErrors = Array.isArray(job.errors) ? (job.errors as ImportRowError[]) : [];
      const room = Math.max(0, deps.config.maxErrors - keptErrors.length);
      const failedRows = job.failedRows + errors.length;
      const progress: Partial<typeof importJobs.$inferInsert> = {
        cursor: end,
        createdRows: job.createdRows + created,
        updatedRows: job.updatedRows + updated,
        failedRows,
        errors: [...keptErrors, ...errors.slice(0, room)],
        errorsTruncated: job.errorsTruncated + Math.max(0, errors.length - room),
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: deps.now?.() ?? new Date(),
      };
      if (end >= job.totalRows) {
        const failedAll = failedRows === job.totalRows;
        Object.assign(progress, {
          status: failedAll ? 'failed' : 'succeeded',
          message: failedAll ? 'Every row failed; see the error report.' : null,
          source: '',
          finishedAt: progress.updatedAt,
        });
      }
      const [row] = await tx
        .update(importJobs)
        .set(progress)
        .where(and(eq(importJobs.id, job.id), eq(importJobs.leaseOwner, owner)))
        .returning(importJobColumns);
      if (!row) throw new LeaseLostError();
      // The chunk is consumed in the same commit that moves the cursor past it.
      await tx
        .delete(importChunks)
        .where(
          row.finishedAt
            ? eq(importChunks.jobId, job.id)
            : and(eq(importChunks.jobId, job.id), eq(importChunks.startRow, start)),
        );
      return row;
    });
  } catch (err) {
    if (err instanceof LeaseLostError) return 'busy';
    throw err;
  }

  await publishProgress(deps, committed);
  return TERMINAL_STATUSES.includes(committed.status as ImportStatus) ? 'done' : 'progressed';
}

async function exists(svc: ItemService, collection: string, id: string): Promise<boolean> {
  try {
    await svc.detail(collection, id);
    return true;
  } catch (err) {
    if (err instanceof ItemServiceError && err.code === 'NOT_FOUND') return false;
    throw err;
  }
}

/**
 * Run steps until the job ends, another worker holds it, or `budgetMs` is
 * spent. Whatever is left is picked up by the next tick.
 */
export async function driveImportJob(deps: ImportStepDeps, jobId: string, budgetMs: number): Promise<StepOutcome> {
  const startedAt = Date.now();
  let outcome: StepOutcome = 'progressed';
  while (outcome === 'progressed' && Date.now() - startedAt < budgetMs) {
    outcome = await runImportStep(deps, jobId);
  }
  return outcome;
}

/**
 * Cron entry: resume unfinished jobs whose lease is free. Uses the system
 * connection (crosses sites). Returns how many jobs it stepped.
 *
 * Fair across sites and jobs (#860):
 *  - selection ranks due jobs within their site (oldest first) and takes the
 *    first job of every site before the second of any, so one site's backlog
 *    cannot fill the whole `limit`;
 *  - the budget is shared round-robin, one chunk per job per round, so a large
 *    import cannot hold the tick until it finishes while other jobs wait (and
 *    run into their own timeout).
 */
export async function runImportTick(deps: ImportStepDeps, opts: { budgetMs?: number; limit?: number } = {}): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const ranked = deps.db
    .select({
      id: importJobs.id,
      createdAt: importJobs.createdAt,
      siteRank: sql<number>`row_number() over (partition by ${importJobs.siteId} order by ${importJobs.createdAt}, ${importJobs.id})`.as(
        'site_rank',
      ),
    })
    .from(importJobs)
    .where(
      and(
        inArray(importJobs.status, ['queued', 'running']),
        or(isNull(importJobs.leaseUntil), lt(importJobs.leaseUntil, now)),
      ),
    )
    .as('ranked');
  const due = await deps.db
    .select({ id: ranked.id })
    .from(ranked)
    .orderBy(asc(ranked.siteRank), asc(ranked.createdAt), asc(ranked.id))
    .limit(opts.limit ?? 10);

  const budget = opts.budgetMs ?? 45_000;
  const started = Date.now();
  const stepped = new Set<string>();
  let active = due.map((d) => d.id);
  while (active.length > 0) {
    const next: string[] = [];
    for (const id of active) {
      if (Date.now() - started >= budget) return stepped.size;
      try {
        const outcome = await runImportStep(deps, id);
        stepped.add(id);
        if (outcome === 'progressed') next.push(id);
      } catch (err) {
        console.error('[import] tick step failed', { jobId: id, err: err instanceof Error ? err.message : String(err) });
      }
    }
    active = next;
  }
  return stepped.size;
}

// ── Cancel / read ─────────────────────────────────────────────────────────────

/**
 * Ask a job to stop. A queued job is cancelled at once; a running one stops at
 * its next step boundary (the current chunk finishes).
 */
export async function requestCancel(db: Database, siteId: string, jobId: string): Promise<ImportJobRow> {
  const now = new Date();
  const [queued] = await db
    .update(importJobs)
    .set({ status: 'cancelled', cancelRequestedAt: now, message: 'Cancelled before it started.', source: '', finishedAt: now, updatedAt: now })
    .where(and(eq(importJobs.id, jobId), eq(importJobs.siteId, siteId), eq(importJobs.status, 'queued'), isNull(importJobs.leaseUntil)))
    .returning(importJobColumns);
  if (queued) {
    await db.delete(importChunks).where(and(eq(importChunks.jobId, jobId), eq(importChunks.siteId, siteId)));
    return queued;
  }
  const [running] = await db
    .update(importJobs)
    .set({ cancelRequestedAt: now, updatedAt: now })
    .where(and(eq(importJobs.id, jobId), eq(importJobs.siteId, siteId), inArray(importJobs.status, ['queued', 'running'])))
    .returning(importJobColumns);
  if (running) return running;
  const [existing] = await db
    .select({ status: importJobs.status })
    .from(importJobs)
    .where(and(eq(importJobs.id, jobId), eq(importJobs.siteId, siteId)))
    .limit(1);
  if (!existing) throw new ImportError('NOT_FOUND', 'Import job not found.', 404);
  throw new ImportError('CONFLICT', `Import job already ${existing.status}.`, 409);
}

/** CSV error report: `row,id,message`. */
export function errorReportCsv(errors: ImportRowError[], truncated: number): string {
  const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['row,id,message', ...errors.map((e) => [String(e.row), q(e.id ?? ''), q(e.message)].join(','))];
  if (truncated > 0) lines.push(`,,${q(`${truncated} more row errors were not kept.`)}`);
  return '﻿' + lines.join('\r\n') + '\r\n';
}
