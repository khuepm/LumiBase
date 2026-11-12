/**
 * Background collection imports (#726, epic #673 I01).
 *
 * An upload becomes a row in `lumibase_import_jobs`; workers then process it
 * in chunks under a short lease:
 *
 *   createImportJob   validate + parse once (400 on a bad file), store, queue
 *   runImportStep     claim → check cancel/timeout → re-resolve principal →
 *                     write the next chunk → record counters/errors → release
 *   driveImportJob    loop steps within a time budget (request `waitUntil`)
 *   runImportTick     cron: resume jobs whose lease expired, honouring the
 *                     per-site concurrency limit
 *
 * Every row goes through `ItemService` bound to the job's principal, so
 * validation, permissions, hooks, revisions and CDC behave exactly as for a
 * normal create/update. The principal is re-resolved at every step, so a
 * revoked grant or deleted key stops the job.
 *
 * Works the same on Workers and Node: the only moving parts are SQL updates
 * guarded on `lease_until`, so overlapping ticks never process a chunk twice.
 */
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { importJobs, type Database } from '@lumibase/database';
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
  return {
    ...DEFAULT_IMPORT_CONFIG,
    timeoutMs: positiveInt(env.IMPORT_TIMEOUT, DEFAULT_IMPORT_CONFIG.timeoutMs / 1000, 7 * 24 * 3600) * 1000,
    maxConcurrency: positiveInt(env.IMPORT_MAX_CONCURRENCY, DEFAULT_IMPORT_CONFIG.maxConcurrency, 1000),
    maxBytes: positiveInt(env.IMPORT_MAX_BYTES, DEFAULT_IMPORT_CONFIG.maxBytes, 1024 * 1024 * 1024),
    chunkSize: positiveInt(env.IMPORT_CHUNK_SIZE, DEFAULT_IMPORT_CONFIG.chunkSize, 5000),
  };
}

export class ImportError extends Error {
  constructor(
    public readonly code: 'VALIDATION' | 'PAYLOAD_TOO_LARGE' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
    public readonly status: 400 | 404 | 409 | 413 = 400,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

type ImportJobRow = typeof importJobs.$inferSelect;

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
  const [row] = await input.db
    .insert(importJobs)
    .values({
      siteId: input.siteId,
      collection: input.collection,
      format: input.format,
      mode: input.mode,
      status: 'queued',
      principal: input.principal,
      createdBy: input.createdBy,
      source: input.body,
      sourceBytes: bytes,
      totalRows: records.length,
      timeoutMs: input.config.timeoutMs,
    })
    .returning();
  return row!;
}

// ── Step ──────────────────────────────────────────────────────────────────────

export interface ImportStepDeps {
  db: Database;
  config: ImportConfig;
  realtime?: RealtimeProvider;
  /** Injectable for tests; defaults to the real principal-bound ItemService. */
  itemServiceFor?: (job: ImportJobRow) => Promise<ItemService | { denied: string }>;
  now?: () => Date;
}

export type StepOutcome = 'progressed' | 'done' | 'busy' | 'waiting';

async function defaultItemServiceFor(db: Database, job: ImportJobRow): Promise<ItemService | { denied: string }> {
  const resolution = await resolvePrincipalCapabilities(
    new EffectiveCapabilityService({ db, siteId: job.siteId }),
    job.principal as AuthenticatedPrincipalRef,
  );
  if (!resolution.allowed || !resolution.permissionContext) {
    return { denied: resolution.message ?? 'The principal that started this import is no longer authorised.' };
  }
  return itemServiceForPrincipal(
    { db, siteId: job.siteId, userId: job.createdBy ?? null },
    resolution.permissionContext,
  );
}

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

/** Finish a job: set a terminal status, drop the source, release the lease. */
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
    .returning();
  if (row) await publishProgress(deps, row);
  return row;
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

  const [current] = await deps.db.select().from(importJobs).where(eq(importJobs.id, jobId)).limit(1);
  if (!current) return 'done';
  if (TERMINAL_STATUSES.includes(current.status as ImportStatus)) return 'done';

  if (current.status === 'queued') {
    const [{ running }] = (await deps.db
      .select({ running: sql<number>`count(*)::int` })
      .from(importJobs)
      .where(and(eq(importJobs.siteId, current.siteId), eq(importJobs.status, 'running')))) as [{ running: number }];
    if (running >= deps.config.maxConcurrency && current.cancelRequestedAt === null) return 'waiting';
  }

  // Claim: only when nobody holds a live lease.
  const [job] = await deps.db
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
    .returning();
  if (!job) return 'busy';

  if (job.cancelRequestedAt) {
    await finish(deps, job.id, owner, 'cancelled', 'Cancelled by request.');
    return 'done';
  }
  if (job.startedAt && now.getTime() - job.startedAt.getTime() > job.timeoutMs) {
    await finish(deps, job.id, owner, 'timed_out', `Stopped after the ${Math.round(job.timeoutMs / 1000)} s import timeout.`);
    return 'done';
  }

  const svc = await (deps.itemServiceFor ?? ((j) => defaultItemServiceFor(deps.db, j)))(job);
  if ('denied' in svc) {
    await finish(deps, job.id, owner, 'failed', svc.denied);
    return 'done';
  }

  let records: ImportRecord[];
  try {
    const meta = await svc.describeForExport(job.collection);
    records = parseExport(job.source, job.format as ExportFormat, meta.fields);
  } catch (err) {
    await finish(deps, job.id, owner, 'failed', err instanceof Error ? err.message : 'Could not read the import file.');
    return 'done';
  }

  const start = job.cursor;
  const end = Math.min(start + deps.config.chunkSize, records.length);
  let created = 0;
  let updated = 0;
  const errors: ImportRowError[] = [];
  for (let i = start; i < end; i++) {
    const rec = records[i]!;
    try {
      const payload = { data: rec.data, ...(rec.status ? { status: rec.status } : {}), ...(rec.sort !== undefined ? { sort: rec.sort } : {}) };
      if (job.mode === 'upsert' && rec.id && (await exists(svc, job.collection, rec.id))) {
        await svc.patch(job.collection, rec.id, payload);
        updated++;
      } else {
        await svc.create(job.collection, payload);
        created++;
      }
    } catch (err) {
      errors.push(rowError(i + 1, rec, err));
    }
  }

  const keptErrors = Array.isArray(job.errors) ? (job.errors as ImportRowError[]) : [];
  const room = Math.max(0, deps.config.maxErrors - keptErrors.length);
  const nextErrors = [...keptErrors, ...errors.slice(0, room)];
  const progress = {
    cursor: end,
    createdRows: job.createdRows + created,
    updatedRows: job.updatedRows + updated,
    failedRows: job.failedRows + errors.length,
    errors: nextErrors,
    errorsTruncated: job.errorsTruncated + Math.max(0, errors.length - room),
  };

  if (end >= records.length) {
    const failedAll = progress.failedRows === records.length;
    await finish(
      deps,
      job.id,
      owner,
      failedAll ? 'failed' : 'succeeded',
      failedAll ? 'Every row failed; see the error report.' : null,
      progress,
    );
    return 'done';
  }

  const [row] = await deps.db
    .update(importJobs)
    .set({ ...progress, leaseOwner: null, leaseUntil: null, updatedAt: deps.now?.() ?? new Date() })
    .where(and(eq(importJobs.id, job.id), eq(importJobs.leaseOwner, owner)))
    .returning();
  if (row) await publishProgress(deps, row);
  return 'progressed';
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
 * Cron entry: resume unfinished jobs whose lease is free, oldest first. Uses
 * the system connection (crosses sites). Returns how many jobs it touched.
 */
export async function runImportTick(deps: ImportStepDeps, opts: { budgetMs?: number; limit?: number } = {}): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const due = await deps.db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(
      and(
        inArray(importJobs.status, ['queued', 'running']),
        or(isNull(importJobs.leaseUntil), lt(importJobs.leaseUntil, now)),
      ),
    )
    .orderBy(asc(importJobs.createdAt))
    .limit(opts.limit ?? 10);
  const budget = opts.budgetMs ?? 45_000;
  const started = Date.now();
  let touched = 0;
  for (const { id } of due) {
    const left = budget - (Date.now() - started);
    if (left <= 0) break;
    try {
      await driveImportJob(deps, id, left);
      touched++;
    } catch (err) {
      console.error('[import] tick step failed', { jobId: id, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return touched;
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
    .returning();
  if (queued) return queued;
  const [running] = await db
    .update(importJobs)
    .set({ cancelRequestedAt: now, updatedAt: now })
    .where(and(eq(importJobs.id, jobId), eq(importJobs.siteId, siteId), inArray(importJobs.status, ['queued', 'running'])))
    .returning();
  if (running) return running;
  const [existing] = await db
    .select()
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
