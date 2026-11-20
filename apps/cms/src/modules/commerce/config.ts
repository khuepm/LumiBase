/**
 * Per-site commerce connection (#764). The whole config of a provider (URL or
 * shop domain, API key or access token, webhook secret) is one encrypted site
 * tool secret, `COMMERCE_MEDUSA` / `COMMERCE_SHOPIFY`, in the same vault agent
 * tools use. Nothing secret is ever returned.
 */
import { z } from 'zod';
import type { Database } from '@lumibase/database';
import type { KeyProvider } from '@lumibase/runtime';
import { guardedFetch } from '../../services/ssrf-guard';
import { ToolSecretError, ToolSecretService } from '../../services/tool-secret-service';
import { MedusaAdapter } from './medusa';
import { SHOPIFY_DOMAIN_RE, ShopifyAdapter } from './shopify';
import { CommerceError, type CommerceAdapter, type CommerceProviderName, type FetchLike } from './types';

export const secretName = (provider: CommerceProviderName) => `COMMERCE_${provider.toUpperCase()}`;

const secret = z.string().trim().min(8).max(1024);
export const medusaConfigSchema = z
  .object({ apiUrl: z.string().url().max(2048).refine((u) => /^https?:\/\//.test(u), 'apiUrl must be http(s).'), apiKey: secret, webhookSecret: secret })
  .strict();
export const shopifyConfigSchema = z
  .object({ shopDomain: z.string().toLowerCase().regex(SHOPIFY_DOMAIN_RE, 'shopDomain must be <store>.myshopify.com.'), accessToken: secret, webhookSecret: secret })
  .strict();
export const configSchemas = { medusa: medusaConfigSchema, shopify: shopifyConfigSchema } as const;

export type StoredConfig = z.infer<typeof medusaConfigSchema> | z.infer<typeof shopifyConfigSchema>;

/** Test seam: the fetch adapters use (production: the SSRF-guarded fetch). */
export const commerceDeps: { fetch: FetchLike | undefined } = { fetch: undefined };

/** Production fetch: refuses private / loopback / metadata hosts, including after DNS resolution. */
const safeFetch: FetchLike = async (url, init) => {
  try {
    return await guardedFetch(url, init);
  } catch (err) {
    throw new CommerceError('COMMERCE_UNREACHABLE', `Cannot reach the provider: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
};

export interface CommerceStoreDeps {
  db: Database;
  siteId: string;
  keys: KeyProvider | undefined;
}

export class CommerceConfigStore {
  constructor(private readonly deps: CommerceStoreDeps) {}

  private secrets() {
    return new ToolSecretService({ db: this.deps.db, siteId: this.deps.siteId, keys: this.deps.keys });
  }

  async configured(): Promise<CommerceProviderName[]> {
    const names = new Set((await this.secrets().list().catch(() => [])).map((s) => s.name));
    return (['medusa', 'shopify'] as const).filter((p) => names.has(secretName(p)));
  }

  async save(provider: CommerceProviderName, config: StoredConfig, by: string | null): Promise<void> {
    await this.secrets().set(secretName(provider), JSON.stringify(config), by);
  }

  async remove(provider: CommerceProviderName): Promise<boolean> {
    return this.secrets().delete(secretName(provider)).catch(() => false);
  }

  /** The decrypted config, or null when the provider is not connected. */
  async load(provider: CommerceProviderName): Promise<StoredConfig | null> {
    try {
      const raw = (await this.secrets().resolve([secretName(provider)])).get(secretName(provider));
      return raw ? configSchemas[provider].parse(JSON.parse(raw)) : null;
    } catch (err) {
      if (err instanceof ToolSecretError) return null;
      throw err;
    }
  }

  async adapter(provider: CommerceProviderName): Promise<CommerceAdapter> {
    const config = await this.load(provider);
    if (!config) throw new CommerceError('COMMERCE_NOT_CONFIGURED', `${provider} is not connected for this site.`, 404);
    return adapterFor(provider, config);
  }
}

export function adapterFor(provider: CommerceProviderName, config: StoredConfig): CommerceAdapter {
  const fetchImpl = commerceDeps.fetch ?? safeFetch;
  return provider === 'medusa'
    ? new MedusaAdapter(config as z.infer<typeof medusaConfigSchema>, fetchImpl)
    : new ShopifyAdapter(config as z.infer<typeof shopifyConfigSchema>, fetchImpl);
}

/** Non-secret view of a stored config. */
export function describeConfig(provider: CommerceProviderName, config: StoredConfig) {
  return provider === 'medusa'
    ? { provider, apiUrl: (config as z.infer<typeof medusaConfigSchema>).apiUrl }
    : { provider, shopDomain: (config as z.infer<typeof shopifyConfigSchema>).shopDomain };
}
