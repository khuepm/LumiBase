/**
 * Public surface of the video pipeline (#871). PUBLIC / pre-auth on purpose:
 * the provider authenticates with a request signature (webhook) or a
 * short-lived signed token (source pull), never a session. The tenant comes
 * from the verified payload, and every query runs on the db scoped to that
 * site (`scopedDbFor`, B130).
 *
 * - `POST /api/v1/video/webhook/:provider` — provider status callbacks.
 * - `GET  /api/v1/video/source/:token`     — the original, for the provider to pull.
 */
import { Hono, type Context } from 'hono';
import { formatSafeError } from '@lumibase/contracts/utils';
import type { AppEnv } from '../env';
import { scopedDbFor } from '../middleware/db';
import { AuditLogger } from '../modules/audit/logger';
import { isServable } from '../modules/malware-scan';
import {
  applyWebhookEvent,
  DrizzleVideoAssetRepository,
  isVideoMime,
  parsePassthrough,
  sourceSecretFromEnv,
  verifySourceToken,
  videoProviderFromEnv,
  VideoWebhookError,
  type VideoProvider,
} from '../modules/video';
import { loadDamSettings } from '../services/files/dam-settings';
import { DrizzleFileRepository } from '../services/files/file-repository';
import { userContentHeaders } from '../services/upload-security/serve-policy';

export const videoPublicRouter = new Hono<AppEnv>();

const envOf = (c: Context<AppEnv>) => c.env as unknown as Record<string, unknown> | undefined;

/** Seam for tests: the provider the deployment is configured with. */
export const videoPublicDeps = {
  provider: (c: Context<AppEnv>): VideoProvider | null => videoProviderFromEnv(envOf(c)),
  now: (): Date => new Date(),
};

videoPublicRouter.post('/webhook/:provider', async (c) => {
  const provider = videoPublicDeps.provider(c);
  if (!provider || provider.name !== c.req.param('provider')) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'No such video provider.' }] }, 404);
  }
  const raw = await c.req.text();
  let event;
  try {
    event = await provider.verifyWebhook(raw, c.req.raw.headers, videoPublicDeps.now());
  } catch (err) {
    if (err instanceof VideoWebhookError) {
      return c.json({ errors: [{ code: 'UNAUTHORIZED', message: 'Invalid webhook signature.' }] }, 401);
    }
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Malformed webhook body.' }] }, 400);
  }
  // 2xx for anything we do not act on, so the provider stops retrying it.
  const target = event ? parsePassthrough(event.passthrough) : null;
  if (!event || !target) return c.json({ data: { outcome: 'ignored' } });
  try {
    const db = scopedDbFor(c, target.siteId);
    const settings = await loadDamSettings(db, target.siteId);
    const outcome = await applyWebhookEvent(
      {
        repo: new DrizzleFileRepository(db, target.siteId),
        videos: new DrizzleVideoAssetRepository(db, target.siteId),
        provider,
        settings,
        sourceUrl: async () => null,
        now: videoPublicDeps.now,
        audit: async (entry) => {
          await new AuditLogger({ db, siteId: target.siteId }).write({ event: entry.event, metadata: { ...entry } });
        },
      },
      event,
    );
    return c.json({ data: { outcome } });
  } catch (err) {
    // 5xx → the provider redelivers; the sweep's poll is the second backstop.
    console.error('[video-webhook] failed', formatSafeError(err));
    return c.json({ errors: [{ code: 'INTERNAL', message: 'Webhook could not be applied.' }] }, 500);
  }
});

videoPublicRouter.get('/source/:token', async (c) => {
  const secret = sourceSecretFromEnv(envOf(c));
  const claims = secret ? await verifySourceToken(secret, c.req.param('token'), videoPublicDeps.now().getTime()) : null;
  // One answer for every failure, so the endpoint does not reveal which ids exist.
  const gone = () => c.json({ errors: [{ code: 'NOT_FOUND', message: 'Source not available.' }] }, 404);
  if (!claims) return gone();
  const db = scopedDbFor(c, claims.siteId);
  const file = await new DrizzleFileRepository(db, claims.siteId).get(claims.fileId);
  if (!file || file.version !== claims.version || !isVideoMime(file.mime) || !isServable(file.scanStatus)) return gone();
  const obj = await c.get('runtime').storage.get(file.filenameDisk);
  if (!obj) return gone();
  const headers: Record<string, string> = {
    ...userContentHeaders(file.mime, file.filenameDownload),
    'Content-Type': file.mime,
    'Cache-Control': 'private, no-store',
  };
  if (obj.size != null) headers['Content-Length'] = String(obj.size);
  if (c.req.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(obj.body as BodyInit, { status: 200, headers });
});
