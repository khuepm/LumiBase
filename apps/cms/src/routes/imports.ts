import { Hono, type Context } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { importJobs, scopeSite } from '@lumibase/database';
import type { AppEnv } from '../env';
import { runDetached } from '../lib/detached';
import { AuditLogger } from '../modules/audit/logger';
import { principalRefFromAuth } from '../services/effective-capability-service';
import { permissionServiceForRequest } from '../services/item-service-factory';
import {
  ImportError,
  createImportJob,
  driveImportJob,
  errorReportCsv,
  requestCancel,
  resolveImportConfig,
  toJobView,
  type ImportRowError,
} from '../services/import-service';
import { SchemaService } from '../services/schema-service';
import { formatSafeError } from '@lumibase/contracts/utils';

/**
 * Background collection imports (#726).
 *
 *   POST /imports?collection=&format=csv|json&mode=create|upsert   → 202 { data: job }
 *   GET  /imports?collection=&status=&limit=                       → { data: job[] }
 *   GET  /imports/:id                                              → { data: job }
 *   GET  /imports/:id/errors[?format=csv]                          → { data: { errors, truncated } } | CSV
 *   POST /imports/:id/cancel                                       → { data: job }
 *
 * The upload is the file itself: multipart (`file` field) or a raw body
 * (`text/csv`, `application/octet-stream`, …). Raw `application/json` bodies
 * are capped by the global JSON body limit, so send JSON exports as multipart
 * or `application/octet-stream`. Jobs are visible to their creator; site
 * admins see every job.
 */
export const importsRouter = new Hono<AppEnv>();

const envRecord = (c: Context<AppEnv>) => ({
  ...(typeof process !== 'undefined' ? (process.env as Record<string, string | undefined>) : {}),
  ...((c.env ?? {}) as unknown as Record<string, string | undefined>),
});

const createQuery = z.object({
  collection: z.string().min(1),
  format: z.enum(['csv', 'json']).optional(),
  mode: z.enum(['create', 'upsert']).default('create'),
});

const listQuery = z.object({
  collection: z.string().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const fail = (c: Context<AppEnv>, status: 400 | 403 | 404 | 409 | 413, code: string, message: string) =>
  c.json({ errors: [{ code, message }] }, status);

/** Read the upload and infer the format from the file name / content type. */
async function readUpload(
  c: Context<AppEnv>,
  maxBytes: number,
): Promise<{ body: string; format?: 'csv' | 'json' } | { error: string; status: 400 | 413 }> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes + 64 * 1024) {
    return { error: `Import file exceeds the ${maxBytes} byte limit.`, status: 413 };
  }
  const type = c.req.header('content-type') ?? '';
  if (type.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return { error: 'Multipart upload needs a `file` field.', status: 400 };
    const name = (file as File).name?.toLowerCase() ?? '';
    const format = name.endsWith('.csv') ? 'csv' : name.endsWith('.json') ? 'json' : undefined;
    return { body: await (file as File).text(), format };
  }
  const body = await c.req.text();
  const format = type.includes('csv') ? 'csv' : type.includes('json') ? 'json' : undefined;
  return { body, format };
}

importsRouter.post('/', async (c) => {
  const parsed = createQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const { collection, mode } = parsed.data;
  const siteId = c.get('siteId');
  const auth = c.get('auth');
  const principal = principalRefFromAuth(auth, siteId);
  if (!principal) return fail(c, 403, 'FORBIDDEN', 'Imports need an authenticated user or API key.');

  const db = c.get('db');
  const compiled = await new SchemaService({ db: db as never, siteId, cache: c.get('runtime')?.cache }).getCompiled(collection);
  if (!compiled) return fail(c, 404, 'NOT_FOUND', `Collection "${collection}" not found.`);

  // Fail fast on permissions; ItemService re-checks every row while running.
  const permissions = permissionServiceForRequest(c);
  for (const action of mode === 'upsert' ? (['create', 'update'] as const) : (['create'] as const)) {
    if (!(await permissions.canAccess(collection, action))) {
      return fail(c, 403, 'FORBIDDEN', `Action "${action}" on "${collection}" is not allowed.`);
    }
  }

  const config = resolveImportConfig(envRecord(c));
  const upload = await readUpload(c, config.maxBytes);
  if ('error' in upload) return fail(c, upload.status, upload.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION', upload.error);
  const format = parsed.data.format ?? upload.format;
  if (!format) return fail(c, 400, 'VALIDATION', 'Pass `format=csv|json` or upload a .csv / .json file.');

  let job;
  try {
    job = await createImportJob({
      db,
      siteId,
      collection,
      format,
      mode,
      body: upload.body,
      schemaFields: compiled.fields,
      principal,
      createdBy: auth?.userId ?? null,
      config,
    });
  } catch (err) {
    if (err instanceof ImportError) return fail(c, err.status as 400 | 413, err.code, err.message);
    console.error('[imports] create failed', formatSafeError(err));
    return c.json({ errors: [{ code: 'INTERNAL', message: 'Could not create the import job.' }] }, 500);
  }

  await new AuditLogger({ db, siteId }).write({
    event: 'items_import_started',
    actorEmail: auth?.email ?? null,
    targetEmail: null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { jobId: job.id, collection, format, mode, rows: job.totalRows, bytes: job.sourceBytes, apiKeyId: auth?.apiKeyId ?? null },
  });

  // Start now; the minute tick resumes whatever this request's budget leaves.
  runDetached(
    c,
    driveImportJob({ db, config, realtime: c.get('runtime')?.realtime, env: envRecord(c) }, job.id, 20_000).catch((err) =>
      console.error('[imports] first run failed', { jobId: job.id, err: formatSafeError(err) }),
    ),
  );
  return c.json({ data: toJobView(job) }, 202);
});

/** Creator, or a site admin. Returns the row or a response to send. */
async function loadVisibleJob(c: Context<AppEnv>, id: string) {
  const [row] = await c
    .get('db')
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, id), scopeSite(importJobs.siteId, c.get('siteId'))))
    .limit(1);
  if (!row) return { response: fail(c, 404, 'NOT_FOUND', 'Import job not found.') };
  const userId = c.get('auth')?.userId ?? null;
  if (row.createdBy && row.createdBy === userId) return { row };
  if ((await permissionServiceForRequest(c).bundle()).admin) return { row };
  return { response: fail(c, 404, 'NOT_FOUND', 'Import job not found.') };
}

importsRouter.get('/', async (c) => {
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const { collection, status, limit } = parsed.data;
  const admin = (await permissionServiceForRequest(c).bundle()).admin;
  const userId = c.get('auth')?.userId ?? null;
  if (!admin && !userId) return c.json({ data: [] });
  const rows = await c
    .get('db')
    .select()
    .from(importJobs)
    .where(
      and(
        scopeSite(importJobs.siteId, c.get('siteId')),
        collection ? eq(importJobs.collection, collection) : undefined,
        status ? eq(importJobs.status, status) : undefined,
        admin ? undefined : eq(importJobs.createdBy, userId!),
      ),
    )
    .orderBy(desc(importJobs.createdAt))
    .limit(limit);
  return c.json({ data: rows.map(toJobView) });
});

importsRouter.get('/:id', async (c) => {
  const found = await loadVisibleJob(c, c.req.param('id'));
  if ('response' in found) return found.response;
  return c.json({ data: toJobView(found.row) });
});

importsRouter.get('/:id/errors', async (c) => {
  const found = await loadVisibleJob(c, c.req.param('id'));
  if ('response' in found) return found.response;
  const errors = (found.row.errors ?? []) as ImportRowError[];
  if (c.req.query('format') === 'csv') {
    return new Response(errorReportCsv(errors, found.row.errorsTruncated), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="import-${found.row.id}-errors.csv"`,
        'cache-control': 'no-store',
      },
    });
  }
  return c.json({ data: { errors, truncated: found.row.errorsTruncated } });
});

importsRouter.post('/:id/cancel', async (c) => {
  const found = await loadVisibleJob(c, c.req.param('id'));
  if ('response' in found) return found.response;
  try {
    const row = await requestCancel(c.get('db'), c.get('siteId'), found.row.id);
    return c.json({ data: toJobView(row) });
  } catch (err) {
    if (err instanceof ImportError) return fail(c, err.status as 404 | 409, err.code, err.message);
    throw err;
  }
});
