import { settings, scopeSite } from '@lumibase/database';
import { and, eq } from 'drizzle-orm';
import {
  CATALOGUED_UPLOAD_MIME_TYPES,
  DEFAULT_UPLOAD_MIME_TYPES,
  UploadPolicyConfigSchema,
  resolveMaxBytes,
  resolveMimeAllowlist,
  type UploadPolicyConfig,
} from '@lumibase/contracts/schemas';
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

/** Opt-out env for {@link catalogueBoundMimeAllowlist}. */
export const ALLOW_UNCATALOGUED_MIME_ENV = 'FILE_UPLOAD_ALLOW_UNCATALOGUED_MIME';

const CATALOGUED = new Set(CATALOGUED_UPLOAD_MIME_TYPES.map((m) => m.toLowerCase()));
const warnedDropped = new Set<string>();

/**
 * The env MIME override, held to the upload type catalogue (#993).
 *
 * The admin API (`PUT /api/v1/uploads/config`) only accepts catalogued types,
 * because only those have content sniffing and an extension map. The env
 * override used to accept anything — `application/zip`, `text/html`, `*\/*` —
 * so a single variable could re-open exactly the archive downloads FBI FLASH
 * CC-111626-MW describes. Entries outside the catalogue (wildcards included)
 * are now dropped with a one-time warning; an override that drops to nothing
 * falls back to the default. `FILE_UPLOAD_ALLOW_UNCATALOGUED_MIME=true`
 * restores the old behaviour, and `lumibase doctor --security` reports it.
 */
export function catalogueBoundMimeAllowlist(
  raw: string | undefined,
  allowUncatalogued: string | undefined,
): string[] {
  const requested = resolveMimeAllowlist(raw);
  if (allowUncatalogued === 'true') return requested;
  const kept = requested.filter((mime) => CATALOGUED.has(mime.toLowerCase()));
  const dropped = requested.filter((mime) => !CATALOGUED.has(mime.toLowerCase()));
  const fresh = dropped.filter((mime) => !warnedDropped.has(mime));
  if (fresh.length > 0) {
    for (const mime of fresh) warnedDropped.add(mime);
    console.warn(
      `[upload-policy] FILE_UPLOAD_ALLOWED_MIME_TYPES: ignoring types outside the upload catalogue: ${fresh.join(', ')}. ` +
        `Set ${ALLOW_UNCATALOGUED_MIME_ENV}=true to allow them anyway (they are accepted without content sniffing).`,
    );
  }
  return kept.length > 0 ? kept : [...DEFAULT_UPLOAD_MIME_TYPES];
}

/** Config from env override → default, ignoring any DB row. */
export function envFallbackPolicy(env?: Partial<Bindings>): UploadPolicyConfig {
  const allow = (env as Record<string, string | undefined> | undefined)?.[ALLOW_UNCATALOGUED_MIME_ENV]
    ?? process.env[ALLOW_UNCATALOGUED_MIME_ENV];
  return {
    maxBytes: resolveMaxBytes(env?.FILE_UPLOAD_MAX_BYTES ?? process.env.FILE_UPLOAD_MAX_BYTES),
    allowedMimeTypes: catalogueBoundMimeAllowlist(
      env?.FILE_UPLOAD_ALLOWED_MIME_TYPES ?? process.env.FILE_UPLOAD_ALLOWED_MIME_TYPES,
      allow,
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
