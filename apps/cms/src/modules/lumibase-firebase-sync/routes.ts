/**
 * LumiBase Firebase Sync — REST control plane.
 *
 * Mounted UNDER the authenticated `api` Hono at `/firebase-sync`, yielding
 * `/api/v1/firebase-sync/*`. `withTenant` + `withAuth` + `withDb` + `withRls`
 * run upstream; this router additionally enforces site-scoped admin via
 * {@link requireSiteAdmin} (these endpoints move tenant content to a
 * third-party service and store credentials).
 *
 *   POST   /pipelines             — create a sync pipeline
 *   GET    /pipelines             — list pipelines for the active site
 *   GET    /pipelines/:id         — pipeline detail (credentials never echoed)
 *   PATCH  /pipelines/:id         — update config / rotate credentials
 *   DELETE /pipelines/:id         — delete pipeline (+ cascades its log)
 *   GET    /pipelines/:id/log     — recent sync attempts
 *   POST   /pipelines/:id/backfill — push all matching items to Firebase now
 *
 * Firebase credentials are write-only: supplied on create/update, encrypted at
 * rest, and never returned by any read endpoint.
 */

import { collections as collectionsTable, items as itemsTable } from '@lumibase/database';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { requireSiteAdmin } from '../../middleware/site-admin';
import { FirebaseSyncService } from './service';

/**
 * Dev-only fallback AES-256 key (base64). Production MUST set `ENCRYPTION_KEY`;
 * without it, credentials cannot be encrypted and create/update is rejected.
 */
const DEV_FALLBACK_KEY = 'ZGV2LWZpcmViYXNlLXN5bmMta2V5LTMyYnl0ZXMtMDAwMDA=';

function resolveEncryptionKey(c: Context<AppEnv>): string | undefined {
  const fromBinding = c.env?.ENCRYPTION_KEY;
  const fromProcess = typeof process !== 'undefined' ? process.env.ENCRYPTION_KEY : undefined;
  return fromBinding ?? fromProcess;
}

// ── credential schemas (discriminated by target) ────────────────────────────

const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().email(),
  private_key: z.string().min(1),
});

const rtdbCredentialsSchema = z.object({
  databaseUrl: z.string().url(),
  secret: z.string().min(1),
});

const createSchema = z
  .object({
    name: z.string().min(1).max(255),
    target: z.enum(['firestore', 'rtdb']),
    projectId: z.string().min(1),
    credentials: z.union([serviceAccountSchema, rtdbCredentialsSchema]),
    collections: z.array(z.string()).default([]),
    targetPath: z.string().min(1).default('{collection}'),
    syncOnCreate: z.boolean().default(true),
    syncOnUpdate: z.boolean().default(true),
    syncOnDelete: z.boolean().default(true),
    status: z.enum(['active', 'paused']).default('active'),
  })
  .refine(
    (v) =>
      v.target === 'firestore'
        ? serviceAccountSchema.safeParse(v.credentials).success
        : rtdbCredentialsSchema.safeParse(v.credentials).success,
    { message: 'credentials shape must match the selected target', path: ['credentials'] },
  );

const updateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  target: z.enum(['firestore', 'rtdb']).optional(),
  projectId: z.string().min(1).optional(),
  credentials: z.union([serviceAccountSchema, rtdbCredentialsSchema]).optional(),
  collections: z.array(z.string()).optional(),
  targetPath: z.string().min(1).optional(),
  syncOnCreate: z.boolean().optional(),
  syncOnUpdate: z.boolean().optional(),
  syncOnDelete: z.boolean().optional(),
  status: z.enum(['active', 'paused']).optional(),
});

export const lumibaseFirebaseSyncRouter = new Hono<AppEnv>();
lumibaseFirebaseSyncRouter.use('*', requireSiteAdmin());

function getService(c: Context<AppEnv>): FirebaseSyncService {
  const encryptionKey = resolveEncryptionKey(c) ?? DEV_FALLBACK_KEY;
  return new FirebaseSyncService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    encryptionKey,
  });
}

lumibaseFirebaseSyncRouter.get('/pipelines', async (c) => {
  const service = getService(c);
  return c.json({ data: await service.list() });
});

lumibaseFirebaseSyncRouter.get('/pipelines/:id', async (c) => {
  const service = getService(c);
  const pipeline = await service.get(c.req.param('id'));
  if (!pipeline) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: pipeline });
});

lumibaseFirebaseSyncRouter.post('/pipelines', async (c) => {
  const parsed = createSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION_ERROR', issues: parsed.error.issues }] }, 400);
  }
  if (!resolveEncryptionKey(c)) {
    return c.json(
      { errors: [{ code: 'ENCRYPTION_KEY_REQUIRED', message: 'Set ENCRYPTION_KEY to store Firebase credentials.' }] },
      400,
    );
  }
  const service = getService(c);
  const pipeline = await service.create(parsed.data);
  return c.json({ data: pipeline }, 201);
});

lumibaseFirebaseSyncRouter.patch('/pipelines/:id', async (c) => {
  const parsed = updateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION_ERROR', issues: parsed.error.issues }] }, 400);
  }
  if (parsed.data.credentials && !resolveEncryptionKey(c)) {
    return c.json(
      { errors: [{ code: 'ENCRYPTION_KEY_REQUIRED', message: 'Set ENCRYPTION_KEY to rotate Firebase credentials.' }] },
      400,
    );
  }
  const service = getService(c);
  const pipeline = await service.update(c.req.param('id'), parsed.data);
  if (!pipeline) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: pipeline });
});

lumibaseFirebaseSyncRouter.delete('/pipelines/:id', async (c) => {
  const service = getService(c);
  const ok = await service.remove(c.req.param('id'));
  if (!ok) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
});

lumibaseFirebaseSyncRouter.get('/pipelines/:id/log', async (c) => {
  const service = getService(c);
  const pipeline = await service.get(c.req.param('id'));
  if (!pipeline) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: await service.recentLog(c.req.param('id')) });
});

/**
 * Backfill: stream every matching, non-deleted item to Firebase now. Bounded
 * by `limit` (default 500) so one call stays within Worker CPU/time limits;
 * callers paginate via repeated calls. Returns per-collection counts.
 */
lumibaseFirebaseSyncRouter.post('/pipelines/:id/backfill', async (c) => {
  const service = getService(c);
  const id = c.req.param('id');
  const pipeline = await service.get(id);
  if (!pipeline) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);

  const limit = Math.min(Number(c.req.query('limit') ?? 500), 2000);
  const db = c.get('db');
  const siteId = c.get('siteId');

  // Resolve which collections this pipeline targets (empty = all on site).
  const targetCollectionNames =
    pipeline.collections.length > 0 ? pipeline.collections : null;

  const collectionRows = await db
    .select({ id: collectionsTable.id, name: collectionsTable.name })
    .from(collectionsTable)
    .where(eq(collectionsTable.siteId, siteId));

  const byId = new Map(collectionRows.map((r) => [r.id, r.name]));
  let pushed = 0;
  let failed = 0;

  const rows = await db
    .select()
    .from(itemsTable)
    .where(and(eq(itemsTable.siteId, siteId), isNull(itemsTable.deletedAt)))
    .limit(limit);

  for (const row of rows) {
    const collectionName = byId.get(row.collectionId);
    if (!collectionName) continue;
    if (targetCollectionNames && !targetCollectionNames.includes(collectionName)) continue;

    const result = await service.syncItemChange({
      collection: collectionName,
      action: 'update', // backfill is an upsert
      itemId: row.id,
      data: (row.data as Record<string, unknown>) ?? {},
    });
    if (result.succeeded > 0) pushed += 1;
    else if (result.matched > 0) failed += 1;
  }

  return c.json({ data: { scanned: rows.length, pushed, failed, truncated: rows.length === limit } });
});
