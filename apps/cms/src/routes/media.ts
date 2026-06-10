import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { formatSafeError } from '@lumibase/shared/utils';

/**
 * /media — asset storage endpoints powered by the StorageProvider.
 *
 * Provides upload, download, delete, and list operations for media assets.
 * Uses `c.get('runtime').storage` (StorageProvider interface) which is backed
 * by R2 on Cloudflare or S3/MinIO in Docker mode.
 */

const listQuerySchema = z.object({
  prefix: z.string().optional(),
});

export const mediaRouter = new Hono<AppEnv>();

/**
 * GET /media
 * List media assets, optionally filtered by prefix.
 */
mediaRouter.get('/', async (c) => {
  const parsed = listQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const storage = c.get('runtime').storage;
  if (!storage) {
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service is not available.' }] },
      503,
    );
  }

  try {
    const result = await storage.list(parsed.data.prefix);
    return c.json({ data: result.keys });
  } catch (err) {
    console.error('[media] list error', formatSafeError(err));
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service encountered an error.' }] },
      503,
    );
  }
});

/**
 * GET /media/:key
 * Download a media asset by key.
 */
mediaRouter.get('/:key{.+}', async (c) => {
  const key = c.req.param('key');

  const storage = c.get('runtime').storage;
  if (!storage) {
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service is not available.' }] },
      503,
    );
  }

  try {
    const obj = await storage.get(key);
    if (!obj) {
      return c.json(
        { errors: [{ code: 'NOT_FOUND', message: 'Media asset not found.' }] },
        404,
      );
    }

    const headers: Record<string, string> = {};
    if (obj.contentType) headers['Content-Type'] = obj.contentType;
    if (obj.size != null) headers['Content-Length'] = String(obj.size);

    return new Response(obj.body as BodyInit, { status: 200, headers });
  } catch (err) {
    console.error('[media] get error', formatSafeError(err));
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service encountered an error.' }] },
      503,
    );
  }
});

/**
 * POST /media/:key
 * Upload a media asset. The request body is stored as-is.
 * Content-Type header is preserved as metadata.
 *
 * For image uploads, a thumbnail generation job is enqueued (fire-and-forget)
 * to produce predefined sizes (150x150, 300x300, 600x600).
 */
mediaRouter.post('/:key{.+}', async (c) => {
  const key = c.req.param('key');

  const storage = c.get('runtime').storage;
  if (!storage) {
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service is not available.' }] },
      503,
    );
  }

  try {
    const contentType = c.req.header('content-type') ?? 'application/octet-stream';
    const body = await c.req.arrayBuffer();
    const data = Buffer.from(body);

    const metadata: Record<string, string> = { contentType };
    await storage.put(key, data, metadata);

    // Fire-and-forget: enqueue thumbnail generation for image uploads
    if (contentType.startsWith('image/')) {
      try {
        const queue = c.get('runtime').queue;
        if (queue) {
          queue.enqueue('media-processing', 'generate-thumbnails', {
            key,
            sizes: [
              { width: 150, height: 150 },
              { width: 300, height: 300 },
              { width: 600, height: 600 },
            ],
          }).catch((err) => {
            console.warn('[media] failed to enqueue thumbnail generation', formatSafeError(err));
          });
        }
      } catch (err) {
        console.warn('[media] queue unavailable for thumbnail generation', formatSafeError(err));
      }
    }

    return c.json({ data: { key, size: data.byteLength, contentType } }, 201);
  } catch (err) {
    console.error('[media] upload error', formatSafeError(err));
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service encountered an error.' }] },
      503,
    );
  }
});

/**
 * DELETE /media/:key
 * Delete a media asset by key.
 */
mediaRouter.delete('/:key{.+}', async (c) => {
  const key = c.req.param('key');

  const storage = c.get('runtime').storage;
  if (!storage) {
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service is not available.' }] },
      503,
    );
  }

  try {
    await storage.delete(key);
    return c.body(null, 204);
  } catch (err) {
    console.error('[media] delete error', formatSafeError(err));
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service encountered an error.' }] },
      503,
    );
  }
});
