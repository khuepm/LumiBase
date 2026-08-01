import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  UPLOAD_TYPE_CATALOGUE,
  UploadPolicyUpdateSchema,
  extensionsForMimeTypes,
} from '@lumibase/contracts/schemas';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { resolveUploadPolicy, saveUploadPolicy } from '../services/upload-policy-service';

/**
 * /uploads — upload policy configuration surface.
 *
 *   GET /api/v1/uploads/config  — effective policy + catalogue (any member).
 *                                 Studio uses this to constrain the file picker
 *                                 (`accept`) and pre-check size client-side.
 *   PUT /api/v1/uploads/config  — update the per-site allowlist / size cap
 *                                 (site admin only). Persisted to `settings`.
 *
 * The allowlist is the same one the `file-upload-policy` guard enforces on
 * every upload surface — this endpoint only changes what the guard reads, it
 * does not weaken the content sniffing / SVG / executable checks.
 */
export const uploadsRouter = new Hono<AppEnv>();

function policyDeps(c: Context<AppEnv>) {
  return {
    db: c.get('db'),
    cache: c.get('runtime')?.cache,
    siteId: c.get('siteId'),
    env: c.env,
  };
}

uploadsRouter.get('/config', async (c) => {
  const config = await resolveUploadPolicy(policyDeps(c));
  return c.json({
    data: {
      ...config,
      allowedExtensions: extensionsForMimeTypes(config.allowedMimeTypes),
      catalogue: UPLOAD_TYPE_CATALOGUE,
    },
  });
});

uploadsRouter.put('/config', requireSiteAdmin(), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Body must be JSON.' }] }, 400);
  }

  const parsed = UploadPolicyUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) },
      400,
    );
  }

  const deps = policyDeps(c);
  // Merge the partial update onto the current effective policy so a caller can
  // change only the allowlist or only the cap without dropping the other.
  const current = await resolveUploadPolicy(deps);
  const next = {
    maxBytes: parsed.data.maxBytes ?? current.maxBytes,
    allowedMimeTypes: parsed.data.allowedMimeTypes ?? current.allowedMimeTypes,
  };

  try {
    const saved = await saveUploadPolicy({ ...deps, db: deps.db, siteId: deps.siteId }, next);
    return c.json({
      data: {
        ...saved,
        allowedExtensions: extensionsForMimeTypes(saved.allowedMimeTypes),
        catalogue: UPLOAD_TYPE_CATALOGUE,
      },
    });
  } catch (err) {
    console.error('[uploads] failed to save upload policy', formatSafeError(err));
    return c.json(
      { errors: [{ code: 'INTERNAL', message: 'Failed to save upload policy.' }] },
      500,
    );
  }
});
