/**
 * Commerce adapters (#764).
 *
 * - {@link commerceRouter}, mounted at `/api/v1/integrations/commerce`: site
 *   admins connect Medusa or Shopify (credentials stored encrypted, never
 *   returned), run a full sync and read the status.
 * - The provider's signed webhook is in `./webhook.ts` (its own file, so the
 *   self-scoped public mount never touches the request db).
 */
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../env';
import { requireSiteAdmin } from '../../middleware/site-admin';
import { CommerceConfigStore, adapterFor, configSchemas, describeConfig } from './config';
import { fail, handle, json, providerOf, syncDeps } from './http';
import { PRODUCTS_COLLECTION, PROMOTIONS_COLLECTION, ensureCommerceSchema, fullSync } from './sync';
import { COMMERCE_PROVIDERS, type CommerceProviderName } from './types';

const storeOf = (c: Context<AppEnv>) => new CommerceConfigStore({ db: c.get('db'), siteId: c.get('siteId'), keys: c.get('runtime')?.keys });
const webhookUrl = (c: Context<AppEnv>, provider: CommerceProviderName) =>
  `${new URL(c.req.url).origin}/api/v1/commerce-webhooks/${encodeURIComponent(c.get('siteId'))}/${provider}`;

// --- admin ---------------------------------------------------------------------

export const commerceRouter = new Hono<AppEnv>();
commerceRouter.use('*', requireSiteAdmin());

commerceRouter.get('/', async (c) => {
  const store = storeOf(c);
  const connected = await store.configured();
  const providers = await Promise.all(
    COMMERCE_PROVIDERS.map(async (provider) => {
      const config = connected.includes(provider) ? await store.load(provider) : null;
      return config
        ? { ...describeConfig(provider, config), connected: true, webhookUrl: webhookUrl(c, provider) }
        : { provider, connected: false, webhookUrl: webhookUrl(c, provider) };
    }),
  );
  return c.json({ data: { providers, collections: { products: PRODUCTS_COLLECTION, promotions: PROMOTIONS_COLLECTION } } });
});

/** Connect a provider. The credentials are checked against the provider before they are stored. */
commerceRouter.put('/:provider', async (c) => {
  const provider = providerOf(c);
  if (!provider) return fail(c, 404, 'NOT_FOUND', 'Unknown commerce provider.');
  try {
    const config = configSchemas[provider].parse(await json(c));
    if (c.req.query('verify') !== 'false') await adapterFor(provider, config).listProducts(null);
    await storeOf(c).save(provider, config, c.get('auth')?.userId ?? null);
    const { schema } = syncDeps(c, c.get('db'), c.get('siteId'), provider, 'request');
    const created = await ensureCommerceSchema(schema);
    return c.json({ data: { ...describeConfig(provider, config), connected: true, webhookUrl: webhookUrl(c, provider), createdCollections: created } });
  } catch (err) {
    return handle(c, err);
  }
});

commerceRouter.delete('/:provider', async (c) => {
  const provider = providerOf(c);
  if (!provider) return fail(c, 404, 'NOT_FOUND', 'Unknown commerce provider.');
  await storeOf(c).remove(provider);
  return c.json({ data: { provider, connected: false } });
});

/** Full pull: every product and promotion, then removal of what the provider no longer has. */
commerceRouter.post('/:provider/sync', async (c) => {
  const provider = providerOf(c);
  if (!provider) return fail(c, 404, 'NOT_FOUND', 'Unknown commerce provider.');
  try {
    const adapter = await storeOf(c).adapter(provider);
    return c.json({ data: await fullSync({ ...syncDeps(c, c.get('db'), c.get('siteId'), provider, 'request'), adapter }) });
  } catch (err) {
    return handle(c, err);
  }
});
