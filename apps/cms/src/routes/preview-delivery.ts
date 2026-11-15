import { PREVIEW_HEADER, PREVIEW_QUERY_PARAM } from '@lumibase/contracts';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { Database } from '@lumibase/database';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { scopedDbFor } from '../middleware/db';
import { assertPublicIdentifier } from '../services/identifier-guard';
import { PREVIEW_LIST_MAX_LIMIT, PreviewService, type PreviewAuthFailure } from '../services/preview-service';
import { previewAudit, previewError, secretFor } from './preview';

/**
 * Public preview reads (epic #667 — V01 #679, V04 #682), mounted at
 * `/api/v1/deliver/preview` behind the delivery limiter. Tenancy is in the
 * path; every query runs on `scopedDbFor(c, siteId)`, never the request db.
 *
 *   GET /:site_id                          what the token targets (+ the item)
 *   GET /:site_id/items/:collection        live items + the token's overlay
 *   GET /:site_id/items/:collection/:id    one item through the overlay
 *
 * The token is read from the `x-lumibase-preview` header (preferred) or the
 * `?__preview=` query parameter. Every failure answers one 401 body; every
 * response is `no-store` + `noindex`.
 */
export const previewDeliveryRouter = new Hono<AppEnv>();

/** The one body every failed preview read returns (no oracle). */
export const PREVIEW_UNAUTHORIZED_BODY = {
  errors: [{ code: 'PREVIEW_UNAUTHORIZED', message: 'Preview token is invalid, expired or revoked.' }],
} as const;

/** Failures worth an audit row: the signature was ours, so it is not noise. */
const AUDITED_FAILURES: ReadonlySet<PreviewAuthFailure> = new Set(['expired', 'revoked', 'unknown_token', 'creator_mismatch']);

function previewHeaders(c: Context<AppEnv>) {
  c.header('Cache-Control', 'private, no-store, max-age=0');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Vary', `${PREVIEW_HEADER}`);
}

function tokenFrom(c: Context<AppEnv>): string | null {
  const header = c.req.header(PREVIEW_HEADER);
  if (header) return header.trim();
  const query = c.req.query(PREVIEW_QUERY_PARAM);
  return query ? query.trim() : null;
}

type DeliveryAuth =
  | { ok: true; service: PreviewService; row: Parameters<PreviewService['markUsed']>[0]; db: Database; siteId: string }
  | { ok: false; response: Response };

async function authenticateDelivery(c: Context<AppEnv>): Promise<DeliveryAuth> {
  previewHeaders(c);
  const siteId = c.req.param('site_id') ?? '';
  const shape = assertPublicIdentifier('siteId', siteId);
  const token = tokenFrom(c);
  if (!shape.ok || !token) return { ok: false, response: c.json(PREVIEW_UNAUTHORIZED_BODY, 401) };

  // Site from the path, never from the token (B130): RLS scopes every query.
  const db = scopedDbFor(c, siteId);
  const service = new PreviewService({ db, siteId, secret: secretFor(c), cache: c.get('runtime')?.cache });
  const result = await service.authenticate(token);
  if (!result.ok) {
    if (AUDITED_FAILURES.has(result.reason)) {
      await previewAudit(c, db, siteId, 'preview.token_rejected', {
        reason: result.reason,
        previewId: result.row?.id ?? null,
      });
    }
    return { ok: false, response: c.json(PREVIEW_UNAUTHORIZED_BODY, 401) };
  }
  return { ok: true, service, row: result.row, db, siteId };
}

async function recordRead(c: Context<AppEnv>, auth: Extract<DeliveryAuth, { ok: true }>, metadata: Record<string, unknown>) {
  try {
    await auth.service.markUsed(auth.row);
    await previewAudit(c, auth.db, auth.siteId, 'preview.read', { previewId: auth.row.id, ...metadata });
  } catch (err) {
    console.warn('[preview] read bookkeeping failed', formatSafeError(err));
  }
}

previewDeliveryRouter.get('/:site_id', async (c) => {
  const auth = await authenticateDelivery(c);
  if (!auth.ok) return auth.response;
  try {
    const described = await auth.service.describeTarget(auth.row);
    // The creator can no longer read the target → the token is dead to us.
    if (auth.row.collection && auth.row.itemId && !described.item) return c.json(PREVIEW_UNAUTHORIZED_BODY, 401);
    if (auth.row.releaseId && !described.release) return c.json(PREVIEW_UNAUTHORIZED_BODY, 401);
    await recordRead(c, auth, { route: 'target' });
    return c.json({ data: described, meta: { expiresAt: auth.row.expiresAt.toISOString() } });
  } catch (err) {
    const { status, body } = previewError(err);
    return c.json(body, status as 400);
  }
});

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(PREVIEW_LIST_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

previewDeliveryRouter.get('/:site_id/items/:collection', async (c) => {
  const auth = await authenticateDelivery(c);
  if (!auth.ok) return auth.response;
  const collection = c.req.param('collection');
  if (!assertPublicIdentifier('collection', collection).ok) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Collection not found.' }] }, 404);
  }
  const query = listQuery.safeParse({ limit: c.req.query('limit'), offset: c.req.query('offset') });
  if (!query.success) {
    return c.json({ errors: query.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const rows = await auth.service.listItems(auth.row, collection, query.data);
    if (!rows) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Collection not found.' }] }, 404);
    await recordRead(c, auth, { route: 'list', collection });
    return c.json({
      data: rows,
      meta: { limit: query.data.limit ?? 20, offset: query.data.offset ?? 0, locale: auth.row.locale },
    });
  } catch (err) {
    const { status, body } = previewError(err);
    return c.json(body, status as 400);
  }
});

previewDeliveryRouter.get('/:site_id/items/:collection/:id', async (c) => {
  const auth = await authenticateDelivery(c);
  if (!auth.ok) return auth.response;
  const collection = c.req.param('collection');
  const id = c.req.param('id');
  if (!assertPublicIdentifier('collection', collection).ok || !assertPublicIdentifier('siteId', id).ok) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Item not found.' }] }, 404);
  }
  try {
    const item = await auth.service.getItem(auth.row, collection, id);
    if (!item) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Item not found.' }] }, 404);
    await recordRead(c, auth, { route: 'item', collection, itemId: id });
    return c.json({ data: item, meta: { locale: auth.row.locale } });
  } catch (err) {
    const { status, body } = previewError(err);
    return c.json(body, status as 400);
  }
});
