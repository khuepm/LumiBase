import {
  buildPreviewUrl,
  PreviewSettingsSchema,
  PreviewTokenMintSchema,
  type PreviewSettings,
} from '@lumibase/contracts';
import { formatSafeError } from '@lumibase/contracts/utils';
import { collections, scopeSite, settings, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { consumeRateLimit } from '../middleware/rate-limit-helper';
import { isSiteAdmin } from '../middleware/site-admin';
import { AuditLogger } from '../modules/audit/logger';
import { PreviewService, PreviewServiceError, previewSigningSecret } from '../services/preview-service';

/**
 * Preview API (epic #667 — V01 #679, V04 #682).
 *
 * Staff plane (mounted on the authenticated `api` at `/api/v1/preview`):
 *   POST   /token                  mint a site-scoped signed preview token (+ URL)
 *   GET    /tokens                 active tokens (site admin: all; others: own)
 *   POST   /tokens/:id/revoke      revoke one (site admin: any; others: own)
 *   POST   /tokens/revoke-all      rotation — revoke every live token (site admin)
 *   GET    /settings               preview settings (allowed origins, TTL)
 *   PUT    /settings               update them (site admin)
 *
 * The public delivery reads live in `preview-delivery.ts`.
 */
export const previewAdminRouter = new Hono<AppEnv>();

/** Mints per user per minute (AC: rate-limited mint endpoint). */
export const PREVIEW_MINT_LIMIT_PER_MIN = 30;
const SETTINGS_KEY = 'preview';

export function previewError(err: unknown) {
  if (err instanceof PreviewServiceError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  console.error('[preview] unexpected error', formatSafeError(err));
  return { status: 500, body: { errors: [{ code: 'INTERNAL', message: 'Unhandled preview error.' }] } };
}

export function secretFor(c: Context<AppEnv>): string | null {
  return previewSigningSecret(c.env as { JWT_SECRET?: string; NODE_ENV?: string } | undefined);
}

export function previewAudit(c: Context<AppEnv>, db: Database, siteId: string, event: string, metadata: Record<string, unknown>) {
  return new AuditLogger({ db, siteId }).write({
    event,
    actorEmail: c.get('auth')?.email ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? c.req.header('user-agent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata,
  });
}

function userPrincipal(c: Context<AppEnv>): string | null {
  const auth = c.get('auth');
  if (!auth?.userId || auth.type === 'api_key' || auth.apiKeyId) return null;
  return auth.userId;
}

const forbidden = (c: Context<AppEnv>) =>
  c.json({ errors: [{ code: 'FORBIDDEN', message: 'Preview tokens are managed by user principals only.' }] }, 403);

export async function readPreviewSettings(db: Database, siteId: string): Promise<PreviewSettings> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(scopeSite(settings.siteId, siteId), eq(settings.key, SETTINGS_KEY)))
    .limit(1);
  const parsed = PreviewSettingsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : PreviewSettingsSchema.parse({});
}

// ── staff plane ───────────────────────────────────────────────────────────

previewAdminRouter.post('/token', async (c) => {
  const userId = userPrincipal(c);
  if (!userId) return forbidden(c);
  const siteId = c.get('siteId');
  const db = c.get('db');

  const limit = await consumeRateLimit(
    c.get('runtime')?.rateLimiter,
    `rl:preview-mint:${siteId}:${userId}`,
    PREVIEW_MINT_LIMIT_PER_MIN,
    60,
  );
  if (limit.status === 'block') {
    c.header('Retry-After', String(limit.retryAfterSeconds));
    return c.json({ errors: [{ code: 'RATE_LIMITED', message: 'Too many preview tokens minted; retry later.' }] }, 429);
  }
  if (limit.status === 'unavailable' && c.env?.LUMIBASE_RATE_LIMIT_FAIL_CLOSED === 'true') {
    return c.json({ errors: [{ code: 'RATE_LIMIT_UNAVAILABLE', message: 'Rate limiter unavailable.' }] }, 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  const parsed = PreviewTokenMintSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }

  try {
    const prefs = await readPreviewSettings(db, siteId);
    const service = new PreviewService({ db, siteId, secret: secretFor(c), cache: c.get('runtime')?.cache });
    const minted = await service.mint({ ...parsed.data, userId, defaultTtlSeconds: prefs.ttlSeconds });

    let url: string | null = null;
    if (minted.collection) {
      const [coll] = await db
        .select({ meta: collections.meta })
        .from(collections)
        .where(and(scopeSite(collections.siteId, siteId), eq(collections.name, minted.collection)))
        .limit(1);
      const template = (coll?.meta as { previewUrl?: unknown } | undefined)?.previewUrl;
      if (typeof template === 'string') {
        url = buildPreviewUrl(template, {
          id: minted.itemId,
          collection: minted.collection,
          locale: minted.locale,
          token: minted.token,
          version: minted.versionKey,
          release: minted.releaseId,
          slug: typeof parsed.data.itemId === 'string' ? await slugOf(service, minted) : null,
        });
      }
    }

    await previewAudit(c, db, siteId, 'preview.token_minted', {
      previewId: minted.id,
      collection: minted.collection,
      itemId: minted.itemId,
      versionKey: minted.versionKey,
      releaseId: minted.releaseId,
      locale: minted.locale,
      expiresAt: minted.expiresAt.toISOString(),
    });
    return c.json({ data: { ...minted, url } }, 201);
  } catch (err) {
    const { status, body: errBody } = previewError(err);
    return c.json(errBody, status as 400);
  }
});

/** The `slug` placeholder value: the item's `data.slug`, read as its creator sees it. */
async function slugOf(
  service: PreviewService,
  minted: Awaited<ReturnType<PreviewService['mint']>>,
): Promise<string | null> {
  if (!minted.collection || !minted.itemId) return null;
  const item = await service.getItem(
    { ...minted, tokenHash: '' },
    minted.collection,
    minted.itemId,
  );
  const slug = item?.data.slug;
  return typeof slug === 'string' ? slug : null;
}

previewAdminRouter.get('/tokens', async (c) => {
  const userId = userPrincipal(c);
  if (!userId) return forbidden(c);
  const admin = await isSiteAdmin(c);
  const service = new PreviewService({ db: c.get('db'), siteId: c.get('siteId'), secret: secretFor(c) });
  const rows = await service.listActive(admin ? {} : { createdBy: userId });
  return c.json({ data: rows, meta: { total: rows.length, scope: admin ? 'site' : 'own' } });
});

previewAdminRouter.post('/tokens/revoke-all', async (c) => {
  const userId = userPrincipal(c);
  if (!userId) return forbidden(c);
  if (!(await isSiteAdmin(c))) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Only a site admin can rotate preview tokens.' }] }, 403);
  }
  const db = c.get('db');
  const siteId = c.get('siteId');
  const service = new PreviewService({ db, siteId, secret: secretFor(c) });
  const revoked = await service.revokeAll(userId);
  await previewAudit(c, db, siteId, 'preview.tokens_rotated', { revoked });
  return c.json({ data: { revoked } });
});

previewAdminRouter.post('/tokens/:id/revoke', async (c) => {
  const userId = userPrincipal(c);
  if (!userId) return forbidden(c);
  const db = c.get('db');
  const siteId = c.get('siteId');
  try {
    const admin = await isSiteAdmin(c);
    const service = new PreviewService({ db, siteId, secret: secretFor(c) });
    const row = await service.revoke(c.req.param('id'), userId, { ownerOnly: !admin });
    await previewAudit(c, db, siteId, 'preview.token_revoked', { previewId: row.id });
    return c.json({ data: row });
  } catch (err) {
    const { status, body } = previewError(err);
    return c.json(body, status as 400);
  }
});

previewAdminRouter.get('/settings', async (c) => {
  if (!userPrincipal(c)) return forbidden(c);
  return c.json({ data: await readPreviewSettings(c.get('db'), c.get('siteId')) });
});

previewAdminRouter.put('/settings', async (c) => {
  if (!userPrincipal(c)) return forbidden(c);
  if (!(await isSiteAdmin(c))) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Only a site admin can change preview settings.' }] }, 403);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }
  const parsed = PreviewSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  const db = c.get('db');
  const siteId = c.get('siteId');
  const value = { ...parsed.data, allowedOrigins: [...new Set(parsed.data.allowedOrigins.map((o) => o.replace(/\/$/, '')))] };
  await db
    .insert(settings)
    .values({ siteId, key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: [settings.siteId, settings.key], set: { value, updatedAt: new Date() } });
  await previewAudit(c, db, siteId, 'preview.settings_updated', { allowedOrigins: value.allowedOrigins, ttlSeconds: value.ttlSeconds });
  return c.json({ data: value });
});

