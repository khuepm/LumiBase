import { settings, scopeSite } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import {
  UploadPolicyConfigSchema,
  resolveMaxBytes,
  resolveMimeAllowlist,
  type UploadPolicyConfig,
} from '@lumibase/shared/schemas';
import type { CacheProvider } from '@lumibase/runtime';
import type { Database } from '@lumibase/database';
import type { Bindings } from '../env';

/**
 * Upload policy resolution + persistence.
 *
 * Precedence (highest first): per-site DB config (settings row) → env override
 * (`FILE_UPLOAD_*`) → built-in default. Resolution is deliberately fail-safe:
 * if the DB/cache are unavailable or the stored value is malformed, it falls
 * back to the env/default config rather than throwing — the upload guard must
 * never fail open, and it must keep working in unit contexts that mount it
 * without a DB.
 */

export const UPLOAD_POLICY_SETTINGS_KEY = 'upload_policy';
const CACHE_TTL_SECONDS = 300;

const cacheKey = (siteId: string): string => `upload-policy:${siteId}`;

export interface UploadPolicyDeps {
  db?: Database;
  cache?: CacheProvider;
  siteId?: string;
  env?: Partial<Bindings>;
}

/** Config from env override → default, ignoring any DB row. */
export function envFallbackPolicy(env?: Partial<Bindings>): UploadPolicyConfig {
  return {
    maxBytes: resolveMaxBytes(env?.FILE_UPLOAD_MAX_BYTES ?? process.env.FILE_UPLOAD_MAX_BYTES),
    allowedMimeTypes: resolveMimeAllowlist(
      env?.FILE_UPLOAD_ALLOWED_MIME_TYPES ?? process.env.FILE_UPLOAD_ALLOWED_MIME_TYPES,
    ),
  };
}

/**
 * Resolve the effective upload policy for a site. Never throws — returns the
 * env/default config on any failure.
 */
export async function resolveUploadPolicy(deps: UploadPolicyDeps): Promise<UploadPolicyConfig> {
  const fallback = envFallbackPolicy(deps.env);
  if (!deps.db || !deps.siteId) return fallback;

  try {
    if (deps.cache) {
      const cached = await deps.cache.get<UploadPolicyConfig>(cacheKey(deps.siteId));
      if (cached) {
        const parsed = UploadPolicyConfigSchema.safeParse(cached);
        if (parsed.success) return parsed.data;
      }
    }

    const [row] = await deps.db
      .select()
      .from(settings)
      .where(and(eq(settings.key, UPLOAD_POLICY_SETTINGS_KEY), scopeSite(settings.siteId, deps.siteId)))
      .limit(1);

    let config = fallback;
    if (row?.value) {
      const parsed = UploadPolicyConfigSchema.safeParse(row.value);
      if (parsed.success) config = parsed.data;
    }

    if (deps.cache) {
      await deps.cache.set(cacheKey(deps.siteId), JSON.stringify(config), { ttl: CACHE_TTL_SECONDS });
    }
    return config;
  } catch {
    return fallback;
  }
}

/**
 * Persist a site's upload policy and invalidate its cache. Requires `db` +
 * `siteId`. Validates the config before writing.
 */
export async function saveUploadPolicy(
  deps: UploadPolicyDeps & { db: Database; siteId: string },
  config: UploadPolicyConfig,
): Promise<UploadPolicyConfig> {
  const value = UploadPolicyConfigSchema.parse(config);

  await deps.db
    .insert(settings)
    .values({ siteId: deps.siteId, key: UPLOAD_POLICY_SETTINGS_KEY, value, scope: 'site' })
    .onConflictDoUpdate({
      target: [settings.siteId, settings.key],
      set: { value, scope: 'site', updatedAt: new Date() },
    });

  if (deps.cache) {
    await deps.cache.delete(cacheKey(deps.siteId));
  }
  return value;
}
