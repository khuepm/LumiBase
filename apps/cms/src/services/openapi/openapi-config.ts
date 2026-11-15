import { scopeSite, settings, type Database } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthPrincipal } from '../../env';

/**
 * Per-site switch for the live OpenAPI document (#745).
 *
 * Stored in the existing `settings` key/value table under {@link OPENAPI_SETTINGS_KEY}
 * — no migration. A missing row, or a row that does not parse, reads as the
 * default: **disabled**. The generic `POST /settings` endpoint can write this
 * key without going through {@link openApiConfigSchema}, so the reader never
 * trusts the stored shape and fails closed instead.
 */
export const OPENAPI_SETTINGS_KEY = 'openapi';

/**
 * Who may fetch the document, by how the caller authenticated.
 *
 * - `studio`   — staff session (token audience `studio`) or dev admin token
 * - `frontend` — subscriber session (token audience `frontend`, ADR-010)
 * - `api_key`  — any site API key, publishable or secret
 * - `public`   — anonymous caller resolved to the site's `public` role (ADR-011);
 *               only reachable once the site has public access enabled
 */
export const OPENAPI_REALMS = ['studio', 'frontend', 'api_key', 'public'] as const;
export type OpenApiRealm = (typeof OPENAPI_REALMS)[number];

export const openApiConfigSchema = z
  .object({
    enabled: z.boolean(),
    realms: z.array(z.enum(OPENAPI_REALMS)).max(OPENAPI_REALMS.length),
  })
  .strict();

export type OpenApiConfig = z.infer<typeof openApiConfigSchema>;

export const DEFAULT_OPENAPI_CONFIG: OpenApiConfig = Object.freeze({
  enabled: false,
  realms: ['studio'],
}) as OpenApiConfig;

/** Parse a stored value; anything unexpected is the (disabled) default. */
export function parseOpenApiConfig(value: unknown): OpenApiConfig {
  const parsed = openApiConfigSchema.safeParse(value);
  if (!parsed.success) return { ...DEFAULT_OPENAPI_CONFIG, realms: [...DEFAULT_OPENAPI_CONFIG.realms] };
  return { enabled: parsed.data.enabled, realms: [...new Set(parsed.data.realms)] };
}

export async function readOpenApiConfig(db: Database, siteId: string): Promise<OpenApiConfig> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(scopeSite(settings.siteId, siteId), eq(settings.key, OPENAPI_SETTINGS_KEY)))
    .limit(1);
  return parseOpenApiConfig(row?.value);
}

export async function writeOpenApiConfig(
  db: Database,
  siteId: string,
  config: OpenApiConfig,
): Promise<OpenApiConfig> {
  const value = { enabled: config.enabled, realms: [...new Set(config.realms)] };
  await db
    .insert(settings)
    .values({ siteId, key: OPENAPI_SETTINGS_KEY, value })
    .onConflictDoUpdate({
      target: [settings.siteId, settings.key],
      set: { value, updatedAt: new Date() },
    });
  return value;
}

/**
 * Classify the authenticated principal into an OpenAPI realm.
 *
 * Returns null for a principal that fits none of them (no auth at all), which
 * the route treats as "not allowed" — never as a default realm.
 */
export function resolveOpenApiRealm(auth: AuthPrincipal | undefined): OpenApiRealm | null {
  if (!auth) return null;
  if (auth.type === 'anonymous') return 'public';
  if (auth.type === 'api_key' || auth.apiKeyId) return 'api_key';
  if (auth.raw?.dev === true) return 'studio';
  if (auth.isFrontendUser) return 'frontend';
  // Trusted external issuers (`type: 'user'`, set only by that branch of
  // `withAuth`) authenticate a customer's own end users, not staff.
  if (auth.type === 'user') return 'frontend';
  // Internal studio-audience JWT and Cloudflare Access sessions.
  if (auth.userId || auth.externalId) return 'studio';
  return null;
}

export function realmAllowed(config: OpenApiConfig, realm: OpenApiRealm | null): realm is OpenApiRealm {
  return config.enabled && realm !== null && config.realms.includes(realm);
}
