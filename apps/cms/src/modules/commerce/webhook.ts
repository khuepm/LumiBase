/**
 * Provider webhooks (#764), mounted at `/api/v1/commerce-webhooks` with
 * `withDb()` + `withRateLimit()`. Unauthenticated: the site comes from the
 * path and every query goes through `scopedDbFor`. A verified event only
 * names a product; the product itself is fetched from the provider, so a
 * webhook body can never write content.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { scopedDbFor } from '../../middleware/db';
import { CommerceConfigStore, adapterFor } from './config';
import { fail, handle, providerOf, syncDeps } from './http';
import { deleteProduct, syncProduct, syncPromotions } from './sync';

export const commerceWebhookRouter = new Hono<AppEnv>();

/**
 * `POST /:site_id/:provider`. Unknown site or provider, or a provider that is
 * not connected: 404. Bad signature: 401. Anything else is acknowledged with
 * 200 (an event we do not handle is ignored, so the provider does not retry).
 */
commerceWebhookRouter.post('/:site_id/:provider', async (c) => {
  const siteId = c.req.param('site_id');
  const provider = providerOf(c);
  if (!provider || !/^[A-Za-z0-9_-]{1,64}$/.test(siteId)) return fail(c, 404, 'NOT_FOUND', 'Not found.');
  // The site comes from the path, not `withTenant`; scope to it (B130).
  const db = scopedDbFor(c, siteId);
  const raw = await c.req.text();
  if (raw.length > 1_000_000) return fail(c, 400, 'BODY_TOO_LARGE', 'Webhook body too large.');
  try {
    const store = new CommerceConfigStore({ db, siteId, keys: c.get('runtime')?.keys });
    const config = await store.load(provider);
    if (!config) return fail(c, 404, 'NOT_FOUND', 'Not found.');
    const adapter = adapterFor(provider, config);
    if (!(await adapter.verifyWebhook(raw, c.req.raw.headers))) return fail(c, 401, 'INVALID_SIGNATURE', 'Webhook signature does not match.');
    const intent = adapter.parseWebhook(raw, c.req.raw.headers);
    const deps = { ...syncDeps(c, db, siteId, provider, 'webhook'), adapter };
    if (intent.kind === 'ignore') return c.json({ data: { ignored: intent.reason } });
    if (intent.kind === 'product') {
      const result = intent.action === 'delete' ? ((await deleteProduct(deps, intent.externalId)) ? 'deleted' : 'missing') : await syncProduct(deps, intent.externalId);
      return c.json({ data: { product: intent.externalId, result } });
    }
    // Promotions have no single-item read in every provider: refresh the list.
    return c.json({ data: { promotions: await syncPromotions(deps) } });
  } catch (err) {
    return handle(c, err);
  }
});
