import { patchSchema } from '../utils/patch-schema';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { SignJWT, jwtVerify } from 'jose';
import type { AppEnv, Bindings } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { validateUploadFilename } from '@lumibase/contracts/schemas';
import { USAGE_KINDS } from '@lumibase/contracts/platform';
import { formatSafeError } from '@lumibase/contracts/utils';
import { purgeEdgeByTag } from '@lumibase/runtime';
import { recordUsage } from '../platform/usage';
import { etagMatches } from '../services/delivery-cache';
import { userContentHeaders } from '../services/upload-security/serve-policy';
import {
  dispatchItemRevalidation,
  invalidateDeliverTag,
  invalidateItemsTag,
} from '../services/content-invalidation';
import { damSettingsUpdateSchema, saveDamSettings, type DamSettings } from '../services/files/dam-settings';
import { canActOnFile, canPlaceInFolder, type FilesAccess, type FilesAction } from '../services/files/file-access';
import {
  CaptionService,
  captionCreateSchema,
  captionPatchSchema,
  presentCaption,
  type CaptionRecord,
} from '../services/files/captions';
import { FileAssetError, FileAssetService } from '../services/files/file-asset-service';
import type { FileListFilter, FileRecord } from '../services/files/file-repository';
import type { FileUsageReport } from '../services/files/file-usage';
import { filesContext, resolveFilesAccess, type FilesContext } from '../services/files/files-context';
import { buildFolderTree, checkFolderMove, descendantIds, type FolderRow } from '../services/files/folder-tree';
import { stripGpsMetadata } from '../services/files/media-metadata';
import { isServable, runFileScan } from '../modules/malware-scan';
import {
  isVideoEligible,
  presentVideoAsset,
  queueVideo,
  retryVideo,
  submitVideo,
  type VideoJobDeps,
} from '../modules/video';

/**
 * /files — the digital asset library (#670).
 *
 * Access: site admins have full access. Other members need a `files::<action>`
 * permission; its rule is evaluated per file against `folder`, `folder_path`,
 * `uploaded_by`, `mime` and `id`, which is how folder-scoped permissions are
 * expressed (#701, see services/files/file-access.ts). Folder management and
 * the DAM settings stay site-admin only. The JWT-signed byte upload under
 * `/files/upload/*` is authorised by its token, not by a session.
 */
export const filesRouter = new Hono<AppEnv>();

const uploadTokenPayloadSchema = z.object({
  key: z.string().min(1),
  siteId: z.string().min(1),
});

type UploadTokenPayload = z.infer<typeof uploadTokenPayloadSchema>;

function getUploadJwtSecret(env: Bindings): string | null {
  return env.JWT_SECRET || process.env.JWT_SECRET || null;
}

// Helper to sign upload token
async function signUploadToken(payload: UploadTokenPayload, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secretKey);
}

// Helper to verify upload token
async function verifyUploadToken(token: string, secret: string): Promise<UploadTokenPayload> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  const { payload } = await jwtVerify(token, secretKey, {
    algorithms: ['HS256'],
  });
  return uploadTokenPayloadSchema.parse(payload);
}

// --- helpers ---------------------------------------------------------------

type ErrorStatus = 400 | 403 | 404 | 409 | 413 | 415 | 422 | 423 | 503;

function fail(c: Context<AppEnv>, status: ErrorStatus, code: string, message: string, details?: Record<string, unknown>) {
  return c.json({ errors: [{ code, message, ...(details ? { details } : {}) }] }, status);
}

function forbidden(c: Context<AppEnv>, action: FilesAction) {
  return fail(c, 403, 'FORBIDDEN', `Action "files:${action}" is not allowed.`);
}

function handleError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof FileAssetError) return fail(c, err.status, err.code, err.message, err.details);
  if (err instanceof z.ZodError) {
    return c.json({ errors: err.issues.map((i) => ({ code: 'VALIDATION', message: `${i.path.join('.')}: ${i.message}` })) }, 400);
  }
  console.error('[files] unexpected error', formatSafeError(err));
  return fail(c, 503, 'SERVICE_UNAVAILABLE', 'The files service encountered an error.');
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new FileAssetError('VALIDATION', 'Body must be JSON.', 400);
  }
}

/** Run work after the response on both runtimes (`waitUntil` on Workers). */
function background(c: Context<AppEnv>, label: string, work: () => Promise<unknown>): void {
  const task = work().catch((err: unknown) => console.warn(`[files] ${label} failed`, formatSafeError(err)));
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    void task;
  }
}

function service(ctx: FilesContext): FileAssetService {
  return new FileAssetService({ repo: ctx.repo, storage: ctx.storage, settings: ctx.settings, usage: ctx.usage });
}

interface Guarded {
  ctx: FilesContext;
  access: FilesAccess;
  folders: FolderRow[];
}

/** Resolve access + context, or return the 403 response. */
async function guard(c: Context<AppEnv>, action: FilesAction): Promise<Guarded | Response> {
  const access = await resolveFilesAccess(c, action);
  if (!access) return forbidden(c, action);
  const ctx = await filesContext(c);
  const folders = access.admin ? [] : await ctx.repo.listFolders();
  return { ctx, access, folders };
}

/** Load one file the caller may act on; 404 (not 403) for a file outside its scope. */
async function loadFile(g: Guarded, id: string): Promise<FileRecord> {
  const file = await g.ctx.repo.get(id);
  if (!file || !canActOnFile(g.access, file, g.folders)) {
    throw new FileAssetError('NOT_FOUND', 'File not found.', 404);
  }
  return file;
}

export function fileCacheTag(siteId: string, id: string): string {
  return `file:${siteId}:${id}`;
}

function deliveryUrl(c: Context<AppEnv>, id: string): string {
  return `${new URL(c.req.url).origin}/api/v1/files/${encodeURIComponent(id)}/content`;
}

/**
 * After the bytes behind a file changed (replace / restore): drop edge copies
 * of the delivery URL and invalidate every collection whose items reference
 * the file, so referencing pages re-render with the new binary (#703).
 */
function purgeAfterReplace(c: Context<AppEnv>, ctx: FilesContext, file: FileRecord): void {
  const runtime = c.get('runtime');
  const url = deliveryUrl(c, file.id);
  background(c, 'cache purge', async () => {
    const tag = fileCacheTag(ctx.siteId, file.id);
    await runtime.edgeCache?.purge({ urls: [url], tags: [tag] }).catch(() => 0);
    await purgeEdgeByTag(runtime.cache, runtime.edgeCache, tag);
    const usage: FileUsageReport = await service(ctx).usage(file.id).catch(() => ({ total: 0, truncated: false, references: [] }));
    const collections = new Set<string>();
    let pages = false;
    for (const ref of usage.references) {
      if (ref.kind === 'item') collections.add(ref.collection);
      else pages = true;
    }
    for (const collection of collections) {
      await invalidateItemsTag(runtime.cache, ctx.siteId, collection, runtime.edgeCache);
      await dispatchItemRevalidation({ db: c.get('db'), queue: runtime.queue, siteId: ctx.siteId, collection });
    }
    if (pages) await invalidateDeliverTag(runtime.cache, ctx.siteId, runtime.edgeCache);
  });
}

function scheduleScan(c: Context<AppEnv>, ctx: FilesContext, file: FileRecord): void {
  if (file.scanStatus !== 'pending') return;
  background(c, 'malware scan', async () => {
    const outcome = await runFileScan(
      { repo: ctx.repo, storage: ctx.storage, scanner: ctx.scanner, settings: ctx.settings, audit: ctx.audit },
      file.id,
    );
    // A video waits for the scan; hand it to the provider once it is servable.
    const deps = videoDeps(ctx);
    if (deps && outcome.status === 'clean' && isVideoEligible(deps, file)) await submitVideo(deps, file.id);
    return outcome;
  });
}

/** Video job dependencies for this request, or null when the context has no pipeline. */
function videoDeps(ctx: FilesContext): VideoJobDeps | null {
  if (!ctx.video) return null;
  return {
    repo: ctx.repo,
    videos: ctx.video.assets,
    provider: ctx.video.provider,
    settings: ctx.settings,
    sourceUrl: ctx.video.sourceUrl,
    audit: ctx.audit,
  };
}

/**
 * Queue a new or replaced video for transcoding (#871) and submit it after
 * the response. A file still waiting on its malware scan is submitted when
 * the scan comes back clean (above) or by the sweep.
 */
function scheduleVideo(c: Context<AppEnv>, ctx: FilesContext, file: FileRecord): void {
  const deps = videoDeps(ctx);
  if (!deps || !isVideoEligible(deps, file)) return;
  background(c, 'video submit', async () => {
    const queued = await queueVideo(deps, file);
    if (queued && isServable(file.scanStatus)) await submitVideo(deps, file.id);
  });
}

function csv(v: string | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// --- Signed byte upload (registered first: `/upload/:key` must win over `/:id/content`)

// JWT-signed upload URL generator endpoint
filesRouter.post('/presigned-url', async (c) => {
  const access = await resolveFilesAccess(c, 'create');
  if (!access) return forbidden(c, 'create');
  const body = (await c.req.json()) as { filename?: unknown };
  const filename = typeof body.filename === 'string' && body.filename.length > 0 ? body.filename : 'unknown';
  // Refuse to mint an upload URL for a name the upload guard would reject
  // (NUL / control bytes, RTL-override spoofing, traversal, `shell.php.png`),
  // so the key that ends up in storage is never one of those (#740).
  const filenameIssue = validateUploadFilename(filename);
  if (filenameIssue) {
    return c.json(
      { errors: [{ code: 'UPLOAD_UNSAFE_FILENAME', message: `File name is not allowed (${filenameIssue}).` }] },
      400,
    );
  }
  const siteId = c.get('siteId');
  const jwtSecret = getUploadJwtSecret(c.env);
  if (!jwtSecret) {
    return c.json(
      { errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] },
      500,
    );
  }

  const key = `${Date.now()}_${filename}`;
  const token = await signUploadToken({ key, siteId }, jwtSecret);

  const urlObj = new URL(c.req.url);
  const uploadUrl = `${urlObj.origin}/api/v1/files/upload/${encodeURIComponent(key)}?token=${encodeURIComponent(token)}`;

  return c.json({
    data: {
      url: uploadUrl,
      method: 'PUT',
      key,
    }
  });
});

// Stream receiver for JWT-signed uploads
filesRouter.put('/upload/:key', async (c) => {
  const key = c.req.param('key');
  const token = c.req.query('token');

  if (!token) {
    return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Upload token is required.' }] }, 401);
  }

  const jwtSecret = getUploadJwtSecret(c.env);
  if (!jwtSecret) {
    return c.json(
      { errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] },
      500,
    );
  }

  try {
    const payload = await verifyUploadToken(token, jwtSecret);
    if (payload.key !== key) {
      return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Invalid upload token parameters.' }] }, 403);
    }
  } catch (err) {
    return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Expired or invalid upload token.' }] }, 401);
  }

  const runtime = c.get('runtime');
  const contentType = c.req.header('content-type') || 'application/octet-stream';

  const body = c.req.raw.body;
  if (!body) {
    return c.json({ errors: [{ code: 'BAD_REQUEST', message: 'No body provided.' }] }, 400);
  }

  try {
    await runtime.storage.put(key, body, { 'content-type': contentType });
    return c.json({ data: { success: true, key } });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return c.json({ errors: [{ code: 'STORAGE_ERROR', message: `Failed to upload file to storage: ${errorMsg}` }] }, 500);
  }
});

// --- Settings (#703/#705/#706/#707) ----------------------------------------

filesRouter.get('/settings', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  return c.json({ data: g.ctx.settings });
});

filesRouter.put('/settings', requireSiteAdmin(), async (c) => {
  try {
    const patch = damSettingsUpdateSchema.parse(await readJson(c));
    const ctx = await filesContext(c);
    const next: DamSettings = { ...ctx.settings, ...patch } as DamSettings;
    const saved = await saveDamSettings(c.get('db'), ctx.siteId, next);
    return c.json({ data: saved });
  } catch (err) {
    return handleError(c, err);
  }
});

// --- Folders (#701) ----------------------------------------------------------

const folderSchema = z.object({
  name: z.string().trim().min(1).max(255),
  parent: z.string().nullable().optional(),
});

filesRouter.get('/folders', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  return c.json({ data: await g.ctx.repo.listFolders() });
});

filesRouter.get('/folders/tree', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  return c.json({ data: buildFolderTree(await g.ctx.repo.listFolders()) });
});

filesRouter.post('/folders', requireSiteAdmin(), async (c) => {
  try {
    const input = folderSchema.parse(await readJson(c));
    const ctx = await filesContext(c);
    const parent = input.parent ?? null;
    if (parent && !(await ctx.repo.listFolders()).some((f) => f.id === parent)) {
      return fail(c, 400, 'PARENT_NOT_FOUND', 'Parent folder not found.');
    }
    return c.json({ data: await ctx.repo.createFolder({ name: input.name, parent }) });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Rename and/or move a folder. Files keep their ids and URLs: only `parent` changes. */
filesRouter.patch('/folders/:id', requireSiteAdmin(), async (c) => {
  const id = c.req.param('id');
  try {
    const input = patchSchema(folderSchema).parse(await readJson(c));
    const ctx = await filesContext(c);
    const folders = await ctx.repo.listFolders();
    if (!folders.some((f) => f.id === id)) return fail(c, 404, 'NOT_FOUND', 'Folder not found.');
    if (input.parent !== undefined) {
      const problem = checkFolderMove(folders, id, input.parent ?? null);
      if (problem === 'CYCLE') return fail(c, 409, 'FOLDER_CYCLE', 'A folder cannot move into itself or one of its sub-folders.');
      if (problem === 'TOO_DEEP') return fail(c, 409, 'FOLDER_TOO_DEEP', 'The folder tree would become too deep.');
      if (problem) return fail(c, 400, problem, 'Target folder not found.');
    }
    const row = await ctx.repo.updateFolder(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.parent !== undefined ? { parent: input.parent ?? null } : {}),
    });
    if (!row) return fail(c, 404, 'NOT_FOUND', 'Folder not found.');
    return c.json({ data: row });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Only empty folders are deleted — files never lose their folder silently. */
filesRouter.delete('/folders/:id', requireSiteAdmin(), async (c) => {
  const id = c.req.param('id');
  try {
    const ctx = await filesContext(c);
    const contents = await ctx.repo.folderContents(id);
    if (contents.files > 0 || contents.folders > 0) {
      return fail(c, 409, 'FOLDER_NOT_EMPTY', 'Move or delete the folder contents first.', contents);
    }
    const row = await ctx.repo.deleteFolder(id);
    if (!row) return fail(c, 404, 'NOT_FOUND', 'Folder not found.');
    return c.json({ data: null });
  } catch (err) {
    return handleError(c, err);
  }
});

// --- Files -------------------------------------------------------------------

const MAX_PAGE = 1000;
/** Rows scanned in memory to apply a folder rule for non-admin callers. */
const NON_ADMIN_SCAN_CAP = 5000;

const listQuerySchema = z.object({
  folder: z.string().optional(),
  subfolders: z.enum(['true', 'false']).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  mime: z.string().max(500).optional(),
  ids: z.string().max(20_000).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * List / filter the library (media picker backend, #708). Every filter is
 * optional; without `limit` the first 1000 files are returned, newest first.
 * `folder=root` selects files outside any folder; `subfolders=true` widens a
 * folder filter to its whole subtree.
 */
filesRouter.get('/', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  try {
    const q = listQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const limit = q.limit ?? MAX_PAGE;
    const offset = q.offset ?? 0;
    let folderFilter: Array<string | null> | undefined;
    if (q.folder !== undefined) {
      const root = q.folder === 'root' || q.folder === '';
      folderFilter = [root ? null : q.folder];
      if (q.subfolders === 'true') {
        const all = g.folders.length ? g.folders : await g.ctx.repo.listFolders();
        // Root + subfolders = everything; otherwise the folder's whole subtree.
        folderFilter = root ? undefined : [q.folder, ...descendantIds(all, q.folder)];
      }
    }
    const filter: Omit<FileListFilter, 'limit' | 'offset'> = {
      folders: folderFilter,
      search: q.search,
      mime: csv(q.mime),
      ids: csv(q.ids),
    };
    if (g.access.admin) {
      const { rows, total } = await g.ctx.repo.list({ ...filter, limit, offset });
      return c.json({ data: rows, meta: { total, limit, offset } });
    }
    // Non-admins: the policy rule is evaluated per row, so page after filtering.
    const { rows } = await g.ctx.repo.list({ ...filter, limit: NON_ADMIN_SCAN_CAP, offset: 0 });
    const visible = rows.filter((f) => canActOnFile(g.access, f, g.folders));
    return c.json({
      data: visible.slice(offset, offset + limit),
      meta: { total: visible.length, limit, offset, ...(rows.length >= NON_ADMIN_SCAN_CAP ? { truncated: true } : {}) },
    });
  } catch (err) {
    return handleError(c, err);
  }
});

const duplicateQuerySchema = z.object({ hash: z.string(), exclude: z.string().optional() });

/** Same-content files for a SHA-256 the client computed before uploading (#706). */
async function duplicates(c: Context<AppEnv>, input: unknown) {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  try {
    const { hash, exclude } = duplicateQuerySchema.parse(input);
    const rows = await service(g.ctx).duplicatesOf(hash.toLowerCase(), exclude);
    return c.json({ data: rows.filter((f) => canActOnFile(g.access, f, g.folders)) });
  } catch (err) {
    return handleError(c, err);
  }
}

filesRouter.get('/duplicates', (c) => duplicates(c, Object.fromEntries(new URL(c.req.url).searchParams)));
filesRouter.post('/duplicates', async (c) => {
  try {
    return await duplicates(c, await readJson(c));
  } catch (err) {
    return handleError(c, err);
  }
});

// File bytes are uploaded through the JWT-signed upload endpoint below; this
// route persists the file entity after storage accepts the stream, then reads
// the object back to fill the content hash and embedded metadata.
const fileCreateSchema = z.object({
  filenameDisk: z.string(),
  filenameDownload: z.string(),
  mime: z.string(),
  filesize: z.number(),
  width: z.number().optional().nullable(),
  height: z.number().optional().nullable(),
  folder: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

filesRouter.post('/', async (c) => {
  const g = await guard(c, 'create');
  if (g instanceof Response) return g;
  try {
    const input = fileCreateSchema.parse(await readJson(c));
    const userId = c.get('auth')?.userId ?? null;
    const folder = input.folder ?? null;
    if (folder && !(await g.ctx.repo.listFolders()).some((f) => f.id === folder)) {
      return fail(c, 400, 'FOLDER_NOT_FOUND', 'Folder not found.');
    }
    if (!canPlaceInFolder(g.access, folder, g.folders, userId)) return forbidden(c, 'create');
    const svc = service(g.ctx);
    const row = await g.ctx.repo.insert({
      ...input,
      folder,
      uploadedBy: userId,
      storage: 'r2',
      scanStatus: svc.initialScanStatus(),
    });
    recordUsage({ kind: USAGE_KINDS.storageBytes, quantity: input.filesize, unit: 'bytes', attributes: { source: 'files', op: 'add' } });
    const { file, duplicates: dupes } = await svc.ingestRegistered(row);
    scheduleScan(c, g.ctx, file);
    scheduleVideo(c, g.ctx, file);
    return c.json({
      data: file,
      meta: { duplicates: dupes.filter((f) => canActOnFile(g.access, f, g.folders)).map((f) => ({ id: f.id, filenameDownload: f.filenameDownload, folder: f.folder })) },
    });
  } catch (err) {
    return handleError(c, err);
  }
});

const bulkSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(500),
    folder: z.string().nullable().optional(),
    metadata: z
      .object({
        alt: z.string().max(1000).optional(),
        title: z.string().max(500).optional(),
        caption: z.string().max(5000).optional(),
        credit: z.string().max(500).optional(),
        tags: z.array(z.string().max(100)).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((v) => v.folder !== undefined || (v.metadata && Object.keys(v.metadata).length > 0), {
    message: 'Provide folder and/or metadata.',
  });

/**
 * Bulk move and/or bulk edit editorial metadata (#701 drag-to-move, #702 bulk
 * edit after upload). Each file is checked individually; files the caller may
 * not touch are reported in `meta.skipped`, the rest are applied.
 */
filesRouter.post('/bulk', async (c) => {
  const g = await guard(c, 'update');
  if (g instanceof Response) return g;
  try {
    const input = bulkSchema.parse(await readJson(c));
    const userId = c.get('auth')?.userId ?? null;
    const allFolders = g.folders.length ? g.folders : await g.ctx.repo.listFolders();
    if (input.folder && !allFolders.some((f) => f.id === input.folder)) {
      return fail(c, 400, 'FOLDER_NOT_FOUND', 'Folder not found.');
    }
    const rows = await g.ctx.repo.getMany([...new Set(input.ids)]);
    const found = new Set(rows.map((r) => r.id));
    const skipped: Array<{ id: string; reason: string }> = input.ids
      .filter((id) => !found.has(id))
      .map((id) => ({ id, reason: 'NOT_FOUND' }));
    const allowed: string[] = [];
    for (const row of rows) {
      if (!canActOnFile(g.access, row, g.folders)) skipped.push({ id: row.id, reason: 'FORBIDDEN' });
      else if (input.folder !== undefined && !canPlaceInFolder(g.access, input.folder, g.folders, row.uploadedBy ?? userId)) {
        skipped.push({ id: row.id, reason: 'TARGET_FORBIDDEN' });
      } else allowed.push(row.id);
    }
    let updated: FileRecord[] = [];
    if (input.folder !== undefined) updated = await g.ctx.repo.move(allowed, input.folder);
    if (input.metadata && Object.keys(input.metadata).length > 0) {
      updated = await g.ctx.repo.mergeMetadata(allowed, input.metadata);
    }
    return c.json({ data: updated, meta: { updated: updated.length, skipped } });
  } catch (err) {
    return handleError(c, err);
  }
});

filesRouter.get('/:id', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  try {
    return c.json({ data: await loadFile(g, c.req.param('id')) });
  } catch (err) {
    return handleError(c, err);
  }
});

const filePatchSchema = fileCreateSchema.omit({ filenameDisk: true, filesize: true, mime: true });

/**
 * Edit the file entity: rename (`filenameDownload`), move (`folder`),
 * editorial metadata. The id and storage key never change, so every URL and
 * reference keeps working (#701). Bytes change only through `PUT /:id/content`.
 */
filesRouter.patch('/:id', async (c) => {
  const g = await guard(c, 'update');
  if (g instanceof Response) return g;
  try {
    const file = await loadFile(g, c.req.param('id'));
    const input = patchSchema(filePatchSchema).parse(await readJson(c));
    if (input.filenameDownload !== undefined) {
      const issue = validateUploadFilename(input.filenameDownload);
      if (issue) return fail(c, 400, 'UPLOAD_UNSAFE_FILENAME', `File name is not allowed (${issue}).`);
    }
    if (input.folder !== undefined) {
      const target = input.folder ?? null;
      const allFolders = g.folders.length ? g.folders : await g.ctx.repo.listFolders();
      if (target && !allFolders.some((f) => f.id === target)) return fail(c, 400, 'FOLDER_NOT_FOUND', 'Folder not found.');
      if (!canPlaceInFolder(g.access, target, g.folders, file.uploadedBy)) return forbidden(c, 'update');
    }
    const patch: Record<string, unknown> = { ...input };
    if (input.metadata) patch.metadata = { ...(file.metadata as Record<string, unknown>), ...input.metadata };
    const row = await g.ctx.repo.update(file.id, patch);
    if (!row) return fail(c, 404, 'NOT_FOUND', 'File not found.');
    return c.json({ data: row });
  } catch (err) {
    return handleError(c, err);
  }
});

function expectedVersion(c: Context<AppEnv>): number | undefined {
  const raw = c.req.header('if-match') ?? c.req.query('expectedVersion');
  if (!raw) return undefined;
  const m = /^(?:W\/)?"?v?(\d+)"?$/.exec(raw.trim());
  if (!m) throw new FileAssetError('VALIDATION', 'If-Match must be "v<version>".', 400);
  return Number(m[1]);
}

/**
 * Replace a file's bytes in place (#703): same id, same storage key, same
 * folder and references; version bumps, previous bytes are kept for undo,
 * and caches of the file and of referencing content are purged. The body is
 * the raw binary; `Content-Type` is the new MIME; `?filename=` optionally
 * renames the download. `If-Match: "v<n>"` guards against lost updates.
 */
filesRouter.put('/:id/content', async (c) => {
  const g = await guard(c, 'update');
  if (g instanceof Response) return g;
  try {
    const file = await loadFile(g, c.req.param('id'));
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
    const filename = c.req.query('filename') || undefined;
    const result = await service(g.ctx).replaceContent({
      id: file.id,
      bytes,
      mime,
      filename,
      userId: c.get('auth')?.userId ?? null,
      expectedVersion: expectedVersion(c),
    });
    const delta = result.file.filesize - file.filesize;
    if (delta !== 0) {
      recordUsage({ kind: USAGE_KINDS.storageBytes, quantity: delta, unit: 'bytes', attributes: { source: 'files', op: 'replace' } });
    }
    purgeAfterReplace(c, g.ctx, result.file);
    scheduleScan(c, g.ctx, result.file);
    scheduleVideo(c, g.ctx, result.file);
    c.header('ETag', `"v${result.file.version}"`);
    return c.json({ data: result.file, meta: { previousVersion: result.previous } });
  } catch (err) {
    return handleError(c, err);
  }
});

filesRouter.get('/:id/versions', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  try {
    const file = await loadFile(g, c.req.param('id'));
    return c.json({ data: await service(g.ctx).listVersions(file.id), meta: { currentVersion: file.version } });
  } catch (err) {
    return handleError(c, err);
  }
});

filesRouter.post('/:id/versions/:versionId/restore', async (c) => {
  const g = await guard(c, 'update');
  if (g instanceof Response) return g;
  try {
    const file = await loadFile(g, c.req.param('id'));
    const result = await service(g.ctx).restoreVersion(file.id, c.req.param('versionId'), c.get('auth')?.userId ?? null);
    purgeAfterReplace(c, g.ctx, result.file);
    scheduleScan(c, g.ctx, result.file);
    scheduleVideo(c, g.ctx, result.file);
    return c.json({ data: result.file, meta: { previousVersion: result.previous } });
  } catch (err) {
    return handleError(c, err);
  }
});

/** "Where used" (#706): items and pages whose data contains the file id or storage key. */
filesRouter.get('/:id/usage', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  try {
    const file = await loadFile(g, c.req.param('id'));
    const usage = await service(g.ctx).usage(file.id);
    return c.json({ data: usage.references, meta: { total: usage.total, truncated: usage.truncated } });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Re-run the malware scan (site admin): e.g. after the scanner came back up. */
filesRouter.post('/:id/scan', requireSiteAdmin(), async (c) => {
  try {
    const ctx = await filesContext(c);
    if (!ctx.settings.scan.enabled) return fail(c, 409, 'SCAN_DISABLED', 'Malware scanning is not enabled for this site.');
    const file = await ctx.repo.update(c.req.param('id'), { scanStatus: 'pending' });
    if (!file) return fail(c, 404, 'NOT_FOUND', 'File not found.');
    const outcome = await runFileScan(
      { repo: ctx.repo, storage: ctx.storage, scanner: ctx.scanner, settings: ctx.settings, audit: ctx.audit },
      file.id,
    );
    return c.json({ data: (await ctx.repo.get(file.id)) ?? file, meta: { outcome } });
  } catch (err) {
    return handleError(c, err);
  }
});

// --- Video pipeline (#871) --------------------------------------------------

/** Processing state of a video file: `uploaded → processing → ready | failed`. */
filesRouter.get('/:id/video', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  try {
    const file = await loadFile(g, c.req.param('id'));
    const asset = g.ctx.video ? await g.ctx.video.assets.get(file.id) : null;
    return c.json({
      data: asset ? presentVideoAsset(asset) : null,
      meta: {
        enabled: g.ctx.settings.video.enabled,
        providerConfigured: Boolean(g.ctx.video?.provider),
      },
    });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Send a failed (or never-submitted) video to the provider again. */
filesRouter.post('/:id/video/retry', async (c) => {
  const g = await guard(c, 'update');
  if (g instanceof Response) return g;
  try {
    const file = await loadFile(g, c.req.param('id'));
    const deps = videoDeps(g.ctx);
    if (!deps?.provider) return fail(c, 503, 'VIDEO_PROVIDER_NOT_CONFIGURED', 'No video provider is configured for this deployment (VIDEO_PROVIDER).');
    if (!g.ctx.settings.video.enabled) return fail(c, 409, 'VIDEO_DISABLED', 'The video pipeline is not enabled for this site.');
    if (!isVideoEligible(deps, file)) return fail(c, 422, 'NOT_A_VIDEO', 'Only video/* files are processed.');
    const current = await deps.videos.get(file.id);
    if (current && (current.status === 'processing' || current.status === 'ready') && current.fileVersion === file.version) {
      return fail(c, 409, 'VIDEO_NOT_RETRYABLE', `The video is ${current.status}; only failed or queued videos can be retried.`, { status: current.status });
    }
    const { outcome, asset } = await retryVideo(deps, file);
    return c.json({ data: asset ? presentVideoAsset(asset) : null, meta: { outcome } });
  } catch (err) {
    return handleError(c, err);
  }
});

/**
 * Playback URLs for a ready video: the HLS manifest and a poster. With
 * `signedPlayback` (default) both are provider-signed and expire after
 * `playbackTtlSeconds`, the same short-lived-URL model as signed transforms;
 * the response itself is never cached.
 */
filesRouter.get('/:id/video/playback', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  try {
    const file = await loadFile(g, c.req.param('id'));
    const provider = g.ctx.video?.provider;
    if (!g.ctx.video || !provider) return fail(c, 503, 'VIDEO_PROVIDER_NOT_CONFIGURED', 'No video provider is configured for this deployment (VIDEO_PROVIDER).');
    const asset = await g.ctx.video.assets.get(file.id);
    if (!asset || asset.status !== 'ready' || asset.fileVersion !== file.version || !asset.providerAssetId) {
      return fail(c, 409, 'VIDEO_NOT_READY', 'The video has not finished processing.', { status: asset?.status ?? null });
    }
    if (asset.provider !== provider.name) {
      return fail(c, 409, 'VIDEO_PROVIDER_CHANGED', 'The video was processed by another provider; retry it to re-process.', { provider: asset.provider });
    }
    const expiresAt = new Date(Date.now() + g.ctx.settings.video.playbackTtlSeconds * 1000);
    const urls = await provider.playback(
      { providerAssetId: asset.providerAssetId, playbackId: asset.playbackId, signed: asset.signedPlayback },
      expiresAt,
    );
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      data: {
        hls: urls.hls,
        poster: urls.poster,
        expiresAt: urls.expiresAt ? urls.expiresAt.toISOString() : null,
        durationMs: asset.durationMs,
        width: asset.width,
        height: asset.height,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'VideoProviderError') return fail(c, 503, 'VIDEO_PROVIDER_ERROR', err.message);
    return handleError(c, err);
  }
});

// --- Caption / subtitle tracks of a video (#871) -----------------------------

function captionService(c: Context<AppEnv>, g: Guarded): CaptionService {
  if (!g.ctx.captions || !g.ctx.locales) throw new FileAssetError('NOT_FOUND', 'Captions are not available here.', 404);
  return new CaptionService({
    repo: g.ctx.repo,
    captions: g.ctx.captions,
    locales: g.ctx.locales,
    // A caller may only attach a caption file it can see.
    canUseFile: (file) => canActOnFile(g.access, file, g.folders),
  });
}

/** Version-pinned (immutable) delivery URL of a caption file, for `<track src>`. */
function captionSrc(c: Context<AppEnv>) {
  return (fileId: string, version: number) => `${deliveryUrl(c, fileId)}?v=${version}`;
}

async function presentCaptions(c: Context<AppEnv>, g: Guarded, rows: CaptionRecord[]) {
  const files = await g.ctx.repo.getMany([...new Set(rows.map((r) => r.captionFileId))]);
  const byId = new Map(files.map((f) => [f.id, f]));
  return rows.map((r) => {
    const f = byId.get(r.captionFileId) ?? null;
    // A track whose file the caller cannot see is listed without its URL.
    return presentCaption(r, f && canActOnFile(g.access, f, g.folders) ? f : null, captionSrc(c));
  });
}

/** Tracks of a video, ready for `<track kind srclang label src default>`. */
filesRouter.get('/:id/captions', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  try {
    const video = await loadFile(g, c.req.param('id'));
    return c.json({ data: await presentCaptions(c, g, await captionService(c, g).list(video)) });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Attach a WebVTT file from the library as a track (files `update` on the video). */
filesRouter.post('/:id/captions', async (c) => {
  const g = await guard(c, 'update');
  if (g instanceof Response) return g;
  try {
    const video = await loadFile(g, c.req.param('id'));
    const input = captionCreateSchema.parse(await readJson(c));
    const row = await captionService(c, g).add(video, input, c.get('auth')?.userId ?? null);
    const [presented] = await presentCaptions(c, g, [row]);
    return c.json({ data: presented }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

filesRouter.patch('/:id/captions/:captionId', async (c) => {
  const g = await guard(c, 'update');
  if (g instanceof Response) return g;
  try {
    const video = await loadFile(g, c.req.param('id'));
    const patch = captionPatchSchema.parse(await readJson(c));
    const row = await captionService(c, g).update(video, c.req.param('captionId'), patch);
    const [presented] = await presentCaptions(c, g, [row]);
    return c.json({ data: presented });
  } catch (err) {
    return handleError(c, err);
  }
});

/** Detach a track. The WebVTT file itself stays in the library. */
filesRouter.delete('/:id/captions/:captionId', async (c) => {
  const g = await guard(c, 'update');
  if (g instanceof Response) return g;
  try {
    const video = await loadFile(g, c.req.param('id'));
    await captionService(c, g).remove(video, c.req.param('captionId'));
    return c.json({ data: null });
  } catch (err) {
    return handleError(c, err);
  }
});

/**
 * Safe delete (#706). A file that content still references is refused with
 * `409 FILE_IN_USE` and the reference list; under the default `confirm`
 * policy repeating with `?confirm=true` deletes it, under `block` it cannot
 * be deleted until the references are gone.
 */
filesRouter.delete('/:id', async (c) => {
  const g = await guard(c, 'delete');
  if (g instanceof Response) return g;
  try {
    const file = await loadFile(g, c.req.param('id'));
    // Read the video row before the delete cascades it away.
    const video = g.ctx.video ? await g.ctx.video.assets.get(file.id) : null;
    const result = await service(g.ctx).delete(file.id, { confirm: c.req.query('confirm') === 'true' });
    const provider = g.ctx.video?.provider;
    const providerAssetId = video?.providerAssetId;
    if (provider && providerAssetId && video.provider === provider.name) {
      background(c, 'video provider delete', () => provider.remove(providerAssetId));
    }
    if (typeof result.file.filesize === 'number') {
      recordUsage({ kind: USAGE_KINDS.storageBytes, quantity: -result.file.filesize, unit: 'bytes', attributes: { source: 'files', op: 'remove' } });
    }
    return c.json({ data: null, meta: { references: result.usage.total, removedVersions: result.removedVersions } });
  } catch (err) {
    return handleError(c, err);
  }
});

/**
 * Deliver a file's current bytes by id. Mutable URL (revalidates); pin
 * `?v=<version>` for an immutable, year-long cacheable URL — a replace bumps
 * the version, so a pinned URL can never serve stale bytes. Files that are
 * not `skipped`/`clean` under malware scanning are never served (#707). With
 * `stripGpsOnPublic`, GPS positions are removed from the served bytes (#705).
 */
filesRouter.on(['GET', 'HEAD'], '/:id/content', async (c) => {
  const g = await guard(c, 'read');
  if (g instanceof Response) return g;
  try {
    const file = await loadFile(g, c.req.param('id'));
    if (!isServable(file.scanStatus)) {
      const code = file.scanStatus === 'pending' ? 'FILE_SCAN_PENDING' : 'FILE_QUARANTINED';
      return fail(c, 423, code, 'This file is not available until a malware scan marks it clean.', { scanStatus: file.scanStatus });
    }
    const etag = `"v${file.version}${file.contentHash ? `-${file.contentHash.slice(0, 16)}` : ''}${g.ctx.settings.stripGpsOnPublic ? '-g' : ''}"`;
    const pinned = c.req.query('v');
    const headers: Record<string, string> = {
      ETag: etag,
      'Cache-Control':
        pinned && pinned === String(file.version) ? 'public, max-age=31536000, immutable' : 'public, max-age=300, must-revalidate',
      'Cache-Tag': fileCacheTag(g.ctx.siteId, file.id),
      'X-Lumi-File-Version': String(file.version),
      ...userContentHeaders(file.mime, file.filenameDownload),
      'Content-Type': file.mime,
    };
    if (etagMatches(c.req.header('if-none-match'), etag)) return new Response(null, { status: 304, headers });
    const obj = await g.ctx.storage.get(file.filenameDisk);
    if (!obj) return fail(c, 404, 'NOT_FOUND', 'The file has no stored content.');
    let body: Uint8Array | ReadableStream | Buffer = obj.body;
    if (g.ctx.settings.stripGpsOnPublic && file.mime.startsWith('image/')) {
      body = stripGpsMetadata(new Uint8Array(await new Response(obj.body as BodyInit).arrayBuffer()));
      headers['Content-Length'] = String(body.byteLength);
    } else if (obj.size != null) {
      headers['Content-Length'] = String(obj.size);
    }
    if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(body as BodyInit, { status: 200, headers });
  } catch (err) {
    return handleError(c, err);
  }
});
