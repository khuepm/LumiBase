import { Hono } from 'hono';
import { z } from 'zod';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import { type PermissionAction } from '../services/permission-service';
import { permissionServiceForRequest } from '../services/item-service-factory';
import { formatSafeError } from '@lumibase/contracts/utils';
import { scopeSite, settings, transformPresets } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { type TransformDsl, transformDslSchema, transformKey, verifyTransform } from '@lumibase/contracts';

type ResolvedTransform = { dsl: TransformDsl; fromPreset: boolean };

/**
 * Resolve the transform for a delivery request from `?preset=<key>` (looked up
 * in `transform_presets`) or inline `?width=&height=&format=&quality=&fit=`
 * params. Returns null when no transform was requested (serve the original),
 * or throws a ZodError when inline params fail validation. `fromPreset`
 * distinguishes preset vs custom for the `presetOnly` guard.
 */
async function resolveTransform(c: Context<AppEnv>): Promise<ResolvedTransform | null> {
  const url = new URL(c.req.url);
  const presetKey = url.searchParams.get('preset');
  if (presetKey) {
    const [row] = await c
      .get('db')
      .select()
      .from(transformPresets)
      .where(and(eq(transformPresets.key, presetKey), scopeSite(transformPresets.siteId, c.get('siteId'))))
      .limit(1);
    if (!row) return null;
    return { dsl: transformDslSchema.parse(row.dsl), fromPreset: true };
  }
  const raw: Record<string, unknown> = {};
  const num = (v: string | null) => (v == null ? undefined : Number(v));
  if (url.searchParams.get('width')) raw.width = num(url.searchParams.get('width'));
  if (url.searchParams.get('height')) raw.height = num(url.searchParams.get('height'));
  if (url.searchParams.get('format')) raw.format = url.searchParams.get('format');
  if (url.searchParams.get('quality')) raw.quality = num(url.searchParams.get('quality'));
  if (url.searchParams.get('fit')) raw.fit = url.searchParams.get('fit');
  if (Object.keys(raw).length === 0) return null;
  return { dsl: transformDslSchema.parse(raw), fromPreset: false };
}

interface SignedTransformPolicy {
  enabled: boolean;
  presetOnly: boolean;
  secret: string | null;
}

/**
 * Load the site's signed-transform policy from settings key `media.signedTransform`.
 * Absent → disabled (all transforms allowed; backward compatible).
 */
async function loadSignedTransformPolicy(c: Context<AppEnv>): Promise<SignedTransformPolicy> {
  const [row] = await c
    .get('db')
    .select()
    .from(settings)
    .where(and(eq(settings.key, 'media.signedTransform'), scopeSite(settings.siteId, c.get('siteId'))))
    .limit(1);
  const value = (row?.value ?? {}) as { enabled?: boolean; presetOnly?: boolean; secret?: string };
  return {
    enabled: value.enabled === true,
    presetOnly: value.presetOnly === true,
    secret: typeof value.secret === 'string' && value.secret.length > 0 ? value.secret : null,
  };
}

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

function isInvalidKey(key: string): boolean {
  return key.includes('..') || key.startsWith('/');
}

function tenantPrefix(siteId: string): string {
  return `sites/${siteId}/media/`;
}

function storageKey(siteId: string, key: string): string {
  return `${tenantPrefix(siteId)}${key}`;
}

function publicKey(siteId: string, key: string): string {
  const prefix = tenantPrefix(siteId);
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Derive a safe `filename` for the Content-Disposition header from a storage
 * key. Strips any directory prefix and removes characters that could break out
 * of the quoted header value (CR/LF, quotes, backslash, control chars).
 */
function sanitizeDownloadFilename(key: string): string {
  const base = key.split('/').pop() ?? 'download';
  // Replace control chars (incl. CR/LF), double-quotes, and backslash so the
  // value cannot break out of the quoted Content-Disposition filename. Filtered
  // by char code rather than a regex with control-char escapes.
  let cleaned = '';
  for (const ch of base) {
    const code = ch.charCodeAt(0);
    cleaned += code < 0x20 || ch === '"' || ch === '\\' ? '_' : ch;
  }
  cleaned = cleaned.trim();
  return cleaned.length > 0 ? cleaned : 'download';
}

async function requireMediaPermission(
  c: Context<AppEnv>,
  action: Extract<PermissionAction, 'create' | 'read' | 'delete'>,
): Promise<Response | null> {
  const perm = await permissionServiceForRequest(c).canAccess('media', action);

  if (perm) return null;
  return c.json(
    { errors: [{ code: 'FORBIDDEN', message: `Action "media:${action}" is not allowed.` }] },
    403,
  );
}

/**
 * GET /media
 * List media assets, optionally filtered by prefix.
 */
mediaRouter.get('/', async (c) => {
  const forbidden = await requireMediaPermission(c, 'read');
  if (forbidden) return forbidden;

  const parsed = listQuerySchema.safeParse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  if (parsed.data.prefix && isInvalidKey(parsed.data.prefix)) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Invalid prefix format.' }] },
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
    const siteId = c.get('siteId');
    const prefix = storageKey(siteId, parsed.data.prefix ?? '');
    const result = await storage.list(prefix);
    return c.json({ data: result.keys.map((key) => publicKey(siteId, key)) });
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
  const forbidden = await requireMediaPermission(c, 'read');
  if (forbidden) return forbidden;

  const key = c.req.param('key');

  if (isInvalidKey(key)) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Invalid key format.' }] },
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

  // On-the-fly transform: validate the requested DSL, then delegate the actual
  // pixel work to the runtime image processor via its transform URL (CF Image
  // Resizing / Imgproxy on Docker). No transform params → serve the original
  // bytes below (backward compatible). The `Vary` + transform-keyed cache tag
  // let derivatives be invalidated with the source file (ADR-004).
  let transform: ResolvedTransform | null;
  try {
    transform = await resolveTransform(c);
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Invalid transform parameters.' }] }, 400);
  }
  if (transform) {
    const scoped = storageKey(c.get('siteId'), key);
    const dsl = transform.dsl;

    // Abuse guards (image-transform-dsl task 5). presetOnly rejects custom DSLs;
    // signed mode requires a valid HMAC `?sig=` over the (key, dsl) pair.
    const policy = await loadSignedTransformPolicy(c);
    if (policy.presetOnly && !transform.fromPreset) {
      return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Only preset transforms are allowed.' }] }, 403);
    }
    if (policy.enabled && !transform.fromPreset) {
      const sig = new URL(c.req.url).searchParams.get('sig') ?? '';
      const ok = policy.secret ? await verifyTransform(policy.secret, key, dsl, sig) : false;
      if (!ok) {
        return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Missing or invalid transform signature.' }] }, 401);
      }
    }

    const media = c.get('runtime').media;
    const options = {
      width: dsl.width,
      height: dsl.height,
      format: dsl.format,
      quality: dsl.quality,
      fit: dsl.fit,
    };

    // Prefer an in-process byte transform (e.g. Sharp on Docker) when the
    // adapter supports it: fetch the source, transform, and serve directly so
    // the derivative is cacheable under this origin. Falls back to the runtime
    // transform URL (CF Image Resizing / Imgproxy) otherwise.
    if (typeof media.transform === 'function') {
      try {
        const obj = await storage.get(scoped);
        if (!obj) {
          return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Media asset not found.' }] }, 404);
        }
        const srcBytes = await new Response(obj.body as BodyInit).arrayBuffer();
        const out = await media.transform(srcBytes, options);
        return new Response(out.body as unknown as BodyInit, {
          status: 200,
          headers: {
            'Content-Type': out.contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Transform-Key': transformKey(scoped, dsl),
            'X-Content-Type-Options': 'nosniff',
          },
        });
      } catch (err) {
        // Fall through to the URL path if the in-process transform is unavailable.
        console.warn('[media] in-process transform failed, falling back to URL', formatSafeError(err));
      }
    }

    const targetUrl = media.getUrl(scoped, options);
    const res = c.redirect(targetUrl, 302);
    res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.headers.set('X-Transform-Key', transformKey(scoped, dsl));
    return res;
  }

  try {
    const obj = await storage.get(storageKey(c.get('siteId'), key));
    if (!obj) {
      return c.json(
        { errors: [{ code: 'NOT_FOUND', message: 'Media asset not found.' }] },
        404,
      );
    }

    const headers: Record<string, string> = {};
    // `obj.contentType` is the native storage content-type; fall back to the
    // custom metadata copy for objects written before the adapters mapped it
    // onto the native field (older uploads store it only in metadata).
    const contentType = obj.contentType ?? obj.metadata?.contentType;
    if (contentType) headers['Content-Type'] = contentType;
    if (obj.size != null) headers['Content-Length'] = String(obj.size);
    // Serve user-uploaded bytes as a download, never as an inline document.
    // Combined with the global `X-Content-Type-Options: nosniff` + CSP, this
    // stops a stored HTML/SVG payload from being rendered (and its script
    // executed) under this origin when opened top-level. `<img>`/`<video>`
    // embedding of legitimate media is unaffected by Content-Disposition.
    headers['Content-Disposition'] = `attachment; filename="${sanitizeDownloadFilename(key)}"`;
    headers['X-Content-Type-Options'] = 'nosniff';

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
  const forbidden = await requireMediaPermission(c, 'create');
  if (forbidden) return forbidden;

  const key = c.req.param('key');

  if (isInvalidKey(key)) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Invalid key format.' }] },
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
    const contentType = c.req.header('content-type') ?? 'application/octet-stream';
    const body = await c.req.arrayBuffer();
    const data = Buffer.from(body);
    const scopedKey = storageKey(c.get('siteId'), key);

    const metadata: Record<string, string> = { contentType };
    await storage.put(scopedKey, data, metadata);

    // Fire-and-forget: enqueue thumbnail generation for image uploads
    if (contentType.startsWith('image/')) {
      try {
        const queue = c.get('runtime').queue;
        if (queue) {
          queue.enqueue('media-processing', 'generate-thumbnails', {
            key: scopedKey,
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
  const forbidden = await requireMediaPermission(c, 'delete');
  if (forbidden) return forbidden;

  const key = c.req.param('key');

  if (isInvalidKey(key)) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: 'Invalid key format.' }] },
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
    await storage.delete(storageKey(c.get('siteId'), key));
    return c.body(null, 204);
  } catch (err) {
    console.error('[media] delete error', formatSafeError(err));
    return c.json(
      { errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Storage service encountered an error.' }] },
      503,
    );
  }
});
