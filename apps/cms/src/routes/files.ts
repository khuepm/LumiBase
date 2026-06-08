import { files, folders } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { SignJWT, jwtVerify } from 'jose';
import type { AppEnv } from '../env';

export const filesRouter = new Hono<AppEnv>();

// Helper to sign upload token
async function signUploadToken(payload: { key: string; siteId: string }, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secretKey);
}

// Helper to verify upload token
async function verifyUploadToken(token: string, secret: string): Promise<{ key: string; siteId: string }> {
  const encoder = new TextEncoder();
  const secretKey = encoder.encode(secret);
  const { payload } = await jwtVerify(token, secretKey, {
    algorithms: ['HS256'],
  });
  return payload as { key: string; siteId: string };
}

// --- Folders ---
const folderSchema = z.object({
  name: z.string().min(1).max(255),
  parent: z.string().nullable().optional(),
});

filesRouter.get('/folders', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const data = await db.select().from(folders).where(eq(folders.siteId, siteId));
  return c.json({ data });
});

filesRouter.post('/folders', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const input = folderSchema.parse(await c.req.json());

  const [row] = await db
    .insert(folders)
    .values({ ...input, siteId })
    .returning();

  return c.json({ data: row });
});

filesRouter.patch('/folders/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const input = folderSchema.partial().parse(await c.req.json());

  const [row] = await db
    .update(folders)
    .set(input)
    .where(and(eq(folders.siteId, siteId), eq(folders.id, id)))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

filesRouter.delete('/folders/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .delete(folders)
    .where(and(eq(folders.siteId, siteId), eq(folders.id, id)))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
});

// --- Files ---
// File bytes are uploaded through the JWT-signed upload endpoint below; this
// route persists the file entity after storage accepts the stream.
const fileCreateSchema = z.object({
  filenameDisk: z.string(),
  filenameDownload: z.string(),
  mime: z.string(),
  filesize: z.number(),
  width: z.number().optional().nullable(),
  height: z.number().optional().nullable(),
  folder: z.string().optional().nullable(),
});

filesRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const data = await db.select().from(files).where(eq(files.siteId, siteId));
  return c.json({ data });
});

filesRouter.post('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const auth = c.get('auth');
  const input = fileCreateSchema.parse(await c.req.json());

  const [row] = await db
    .insert(files)
    .values({
      ...input,
      siteId,
      uploadedBy: auth?.userId,
      storage: 'r2',
    })
    .returning();

  return c.json({ data: row });
});

filesRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const input = fileCreateSchema.partial().parse(await c.req.json());

  const [row] = await db
    .update(files)
    .set(input)
    .where(and(eq(files.siteId, siteId), eq(files.id, id)))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: row });
});

filesRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .delete(files)
    .where(and(eq(files.siteId, siteId), eq(files.id, id)))
    .returning();

  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  return c.json({ data: null });
});

// JWT-signed upload URL generator endpoint
filesRouter.post('/presigned-url', async (c) => {
  const body = await c.req.json();
  const filename = body.filename || 'unknown';
  const siteId = c.get('siteId');
  const jwtSecret = c.env.JWT_SECRET || 'dev_secret_key';

  const key = `${Date.now()}_${filename}`;
  const token = await signUploadToken({ key, siteId }, jwtSecret);

  const urlObj = new URL(c.req.url);
  const uploadUrl = `${urlObj.origin}/api/v1/files/upload/${key}?token=${encodeURIComponent(token)}`;

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
  const siteId = c.get('siteId');
  const token = c.req.query('token');

  if (!token) {
    return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Upload token is required.' }] }, 401);
  }

  const jwtSecret = c.env.JWT_SECRET || 'dev_secret_key';
  try {
    const payload = await verifyUploadToken(token, jwtSecret);
    if (payload.key !== key || payload.siteId !== siteId) {
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
